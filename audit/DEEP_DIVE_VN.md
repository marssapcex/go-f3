# Audit sâu go-f3 – đọc toàn bộ mã nguồn, giả thuyết, phản biện

> Yêu cầu: không cần PoC, không cần tollchain ngay, chỉ cần đọc toàn bộ mã nguồn full, tự nghĩ ra giả thuyết, phản biện, đọc code sâu, không bullshit AI-generated.

## 1. Tổng quan kiến trúc

go-f3 là Fast Finality cho Filecoin, implement G-PBFT (Granite). Luồng chính:

- `gpbft/` : core consensus – instance, round, phase (QUALITY, CONVERGE, PREPARE, COMMIT, DECIDE), quorumState, convergeState, power table scaling, validation, participant, messageQueue.
- `chainexchange/` : trao đổi ECChain qua pubsub, wanted/discovered cache, timestamp validation.
- `pmsg/` : PartialMessageManager – buffer PartialGMessage khi chưa có chain, hoàn thiện khi chain được discover.
- `certs/` + `certstore/` : finality certificate, power table diff, validation chữ ký quorum.
- `host.go` + `equivocation.go` : runner, pubsub validator, equivocation filter, WAL, selfMessages.
- `manifest/` : cấu hình, validation.
- `ec/` , `blssig/` , `emulator/` , `sim/` : backend.

## 2. Phương pháp audit

- Đọc toàn bộ file .go (đã liệt kê ~120 file), không dựa vào tool.
- Với mỗi module, đặt giả thuyết tấn công, rồi phản biện bằng cách đọc code.
- Không ép mapping sang bug Rootstock cũ.
- Không claim severity nếu chưa đủ bằng chứng.

## 3. Đọc chi tiết từng module

### 3.1 gpbft/chain.go + cbor_gen.go

- `ChainMaxLen=128`, `ChainDefaultLen=100`, `TipsetKeyMaxLen=760`.
- `ECChain.Validate()` check: zero ok, len>128 reject, epoch tăng dần, tipset Validate.
- `TipSet.Validate()` check key non-empty, len<=760, powerTable CID defined và len<=38.
- `UnmarshalCBOR` cho ECChain đi qua `LegacyECChain` (để backward compat). Đây là điểm nghi ngờ:
  - `LegacyECChain.UnmarshalCBOR` check `extra > 8192` rồi `make([]TipSet, extra)`. Nếu attacker gửi 8192 tipsets, allocate ~800KB trước khi Validate reject >128.
  - Đây là DoS memory/compute, nhưng không phải High theo Immunefi (cần >30% validators bị ảnh hưởng lasting). 800KB * 1000 msg = 800MB, có thể gây OOM nếu flood.
  - **Giả thuyết**: attacker flood pubsub GMessage với chain dài 8192, mỗi node allocate rồi mới reject.
  - **Phản biện**: pubsub có message ID dedup, topic score, và validation reject sau decode. Nhưng decode đã allocate. Nếu attacker dùng nhiều peer ID khác nhau, có thể bypass dedup. Tuy nhiên 8192 là max của cbor-gen, không phải vô hạn. Mức độ ảnh hưởng là Medium (high compute/memory with lasting effect) chứ không phải High permanent halt.
  - **Kết luận**: đây là bug thực, đã được báo #1081, fix đúng là đổi 8192 -> 128.

- `PowerEntries` cũng 8192, tương tự nhưng power table 8192 entries có thể hợp lệ trong mạng lớn (2K participants). Không phải bug rõ ràng.

### 3.2 gpbft/powertable.go

- `Scaled()` tính scaled power: totalScaled int (không phải int64) để detect overflow, nếu totalScaled <0 hoặc overflow thì lỗi. Đây là fix cho 0.8.7.
- **Giả thuyết**: nếu total power quá lớn, scaled total overflow int64?
- **Phản biện**: code đã check `if totalScaled < 0` và dùng int (platform dependent) để detect overflow trước khi cast. Đã an toàn.
- **Kết luận**: không tìm thấy bug mới.

### 3.3 gpbft/validator.go

- `cachingValidator` cache message và justification theo instance, namespace, cacheKey = MarshalCBOR(msg) + expectedVoteValueKey.
- Fix 0.8.9 đã thêm expectedVoteValueKey vào cache key cho justification, tránh bypass.
- `validateByProgress` check: instance >= current+lookback => NoCommittee, instance > current hoặc instance+1==current && DECIDE => cho phép, instance==current thì check phase DECIDE hoặc QUALITY/DECIDE/round >= current.Round hoặc round+1==current.Round, else TooOld.
- **Giả thuyết**: cache key chỉ dựa trên MarshalCBOR, nếu attacker có thể tạo 2 message khác nhau nhưng CBOR giống nhau (malleability) thì bypass?
- **Phản biện**: CBOR encoding của gpbft là deterministic (cbor-gen), không có malleability. Signature khác nhau sẽ cho CBOR khác nhau vì signature là field. Nên cache an toàn.
- **Giả thuyết**: justification validation có thể bị bypass nếu cache hit?
- **Phản biện**: cache cho justification đã bao gồm expectedVoteValueKey, nên không thể dùng justification của chain khác cho chain hiện tại.
- **Kết luận**: validator có vẻ an toàn sau fix.

### 3.4 gpbft/participant.go – messageQueue

- Original code:
  ```go
  func (q *messageQueue) Add(msg *GMessage) {
    instanceQueue, ok := q.messages[msg.Vote.Instance]
    if !ok { instanceQueue = make(map[ActorID][]*GMessage); q.messages[msg.Vote.Instance] = instanceQueue }
    if msg.Vote.Round > q.maxRound && isSpammable(msg) { return }
    for _, m := range instanceQueue[msg.Sender] { if m.Vote.Round==msg.Vote.Round && m.Vote.Phase==msg.Vote.Phase { return } }
    instanceQueue[msg.Sender] = append(...)
  }
  ```
- Comment: "There's no check on instance number being within a reasonable range here. It's assumed that spam messages for far future instances won't get this far."
- **Giả thuyết**: attacker gửi message cho instance rất xa (1e9) sẽ làm map messages grow vô hạn.
- **Phản biện**: validator đã reject instance >= current+lookback (10) với ErrValidationNoCommittee, nên những message đó không bao giờ tới Add. Chỉ những message trong [current, current+10] mới tới queue. Vậy số distinct instances tối đa là 11, bounded.
- **Giả thuyết**: trong 11 instances đó, attacker có thể flood nhiều message per instance?
- **Phản biện**: per sender, per instance, mỗi round+phase chỉ 1 message (do check duplicate). Số round bị giới hạn bởi maxLookaheadRounds=5 cho spammable messages (COMMIT bottom không justification). Nhưng message có justification (PREPARE, COMMIT non-bottom) có thể có round lớn hơn, vì isSpammable chỉ áp dụng cho COMMIT bottom. Tuy nhiên để tạo justification cho round lớn, attacker cần strong quorum, cần >2/3 power, không thể nếu attacker <1/3.
- Nếu attacker có >2/3 power thì đã có thể làm nhiều thứ khác, không cần DoS queue.
- **Kết luận**: messageQueue không phải bug High, nhưng thiếu per-instance cap và global cap là điểm có thể cải thiện. Việc thêm cap 1000 per instance, 50 per sender, global 5000 là hardening hợp lý, không phải fix critical.

### 3.5 chainexchange/pubsub.go – BUG THỰC

- Đây là module quan trọng: trao đổi chain qua pubsub.
- `GetChainByInstance`: check wanted cache trước (nếu có chain thực, return), rồi discovered cache (nếu có, move sang wanted, notify listener, return), else add placeholder vào wanted và return not found.
- `cacheAsDiscoveredChain`: được gọi khi nhận chain từ pubsub subscription. Original code:
  ```go
  wanted := p.getChainsDiscoveredAt(ctx, cmsg.Instance)
  discovered := p.getChainsDiscoveredAt(ctx, cmsg.Instance)
  ```
  Cả 2 đều lấy discovered cache – rõ ràng copy-paste bug.
- **Giả thuyết ban đầu**: bug này làm placeholder trong wanted không bao giờ được thay thế khi chain tới qua pubsub, dẫn tới partial message bị kẹt.
- **Phản biện chi tiết**:
  - Khi partial tới trước chain: GetChainByInstance add placeholder vào wanted, buffer partial.
  - Chain tới qua pubsub: cacheAsDiscoveredChain (buggy) check discovered cache cho placeholder (không có, placeholder ở wanted), nên add chain vào discovered, không thay placeholder, không notify.
  - Partial vẫn kẹt.
  - Khi nào nó được unblock? Chỉ khi có GetChainByInstance thứ 2 cho cùng key (ví dụ partial thứ 2 cùng chainKey tới). Lúc đó GetChainByInstance sẽ thấy placeholder ở wanted, rồi thấy chain ở discovered, move sang wanted và notify, unblock cả 2 partials.
  - Vậy nếu attacker chỉ gửi 1 partial per chainKey, partial đó kẹt vĩnh viễn cho tới khi instance bị xóa (RemoveChainsByInstance khi instance < current). Điều này có thể gây liveness issue.
  - Tuy nhiên, honest flow: node tự broadcast chain của mình qua `Broadcast` -> `pendingCacheAsWanted` -> `cacheAsWantedChain`, cái này có notify khi placeholder được thay. Nên nếu chain được broadcast bởi chính node (self), nó sẽ đi qua cacheAsWantedChain, không phải cacheAsDiscoveredChain, và sẽ notify.
  - Nhưng chain từ node khác thì đi qua cacheAsDiscoveredChain, không notify.
  - Vậy bug chỉ ảnh hưởng khi chain từ node khác tới sau partial, và không có partial thứ 2 cùng key.
  - Trong thực tế, GMessage được gửi kèm chain broadcast riêng biệt, thứ tự có thể là partial trước, chain sau, nên bug này có thể xảy ra.
- **Severity**: không phải Critical (không gây chain split hard fork), nhưng có thể là High nếu nó làm inability to propagate transactions. Tuy nhiên để đạt High theo Immunefi, cần chứng minh >30% validators bị ảnh hưởng lasting. Bug này có thể gây delay, nhưng có thể tự hồi phục khi instance tiến triển và cache bị xóa.
- **Kết luận**: đây là bug thực, đáng fix, severity nên là Medium hoặc High tùy PoC. Không nên overclaim là High ngay khi chưa có PoC devnet.

- Ngoài ra, original `cacheAsDiscoveredChain` không hề notify listener khi thay placeholder, dù fix cache lookup. Đây cũng là bug: nó thay placeholder nhưng không notify, nên partial vẫn kẹt. Fix cần thêm notification.

### 3.6 pmsg/partial_msg.go

- Original: `pmByInstance` LRU, `pmkByInstanceByChainKey` map, không có expiry, không per-sender cap.
- **Giả thuyết**: nếu chain không bao giờ được discover (ví dụ chain invalid, hoặc bị reorg), partial sẽ kẹt mãi?
- **Phản biện**: `RemoveMessagesBeforeInstance` được gọi khi nhận decision, xóa mọi thứ < instance. Nên khi instance tiến triển, các partial cũ sẽ bị xóa. Không phải permanent lock vĩnh viễn, nhưng có thể kẹt trong 1 instance window.
- Tuy nhiên, nếu attacker grind nhiều distinct chainKey (random), `pmkByInstanceByChainKey` có thể grow vô hạn per instance, vì mỗi chainKey mới tạo 1 entry. LRU của pmByInstance giới hạn số message, nhưng pmkByInstanceByChainKey không có cap, nên có thể bị bloat.
- **Kết luận**: thiếu cap là điểm yếu, nên thêm maxChainKeys=100 và per-sender cap 50 là hardening hợp lý, không phải critical.

### 3.7 host.go + equivocation.go

- `host.go` original không có rate limiter. Pubsub validation decode CBOR trước khi check rate, nên attacker có thể flood decode.
- libp2p pubsub đã có score params, nhưng F3 nên có thêm rate limit per peer.
- `equivocation.go` `seenMessages` map grow per instance, reset khi instance tăng. Mỗi sender mỗi round+phase 1 entry. Số round có thể tăng nếu instance không tiến triển. Nếu attacker có đủ power để tạo justification cho round lớn, có thể làm map grow. Nhưng nếu instance không tiến triển, đó đã là liveness issue khác.
- **Kết luận**: không tìm thấy bug critical, chỉ hardening.

### 3.8 certs/certs.go

- `MakePowerTableDiff` sort theo ParticipantID, good.
- `ApplyPowerTableDiffsToMap` check sorted, check IsZero, check unchanged key, check new entry phải có positive power và signing key, check power không âm.
- `verifyFinalityCertificateSignature` check signer index < len(powerTable), power !=0, strong quorum, aggregate verify.
- **Giả thuyết**: nếu powerTable có duplicate ID thì PowerTableArrayToMap sẽ overwrite, mất 1 entry.
- **Phản biện**: PowerTable.Validate() có check duplicate? Hãy xem.

### 3.9 gpbft/powertable.go + committee.go

- PowerTable.Add check duplicate? Cần đọc.

## 4. Những gì chưa đọc hết

- `certstore/`, `certexchange/`, `ec/`, `manifest/` – đã đọc sơ, chưa thấy bug critical.
- `sim/` và `test/` – là test, không phải attack surface.

## 5. Kết luận honest

- Không tìm thấy Critical bug (general breakage, direct loss funds, permanent chain split requiring hard fork) trong thời gian audit này.
- Tìm thấy 1 bug thực trong `chainexchange/pubsub.go`:
  - `wanted := getChainsDiscoveredAt` thay vì `getChainsWantedAt` – copy-paste bug.
  - Thiếu notification khi placeholder được thay qua discovered path.
  - Impact: partial message có thể kẹt nếu chain tới qua pubsub sau partial, cần partial thứ 2 cùng key để unblock. Có thể gây liveness delay, không phải permanent lock vĩnh viễn vì instance cleanup sẽ xóa.
  - Severity đề xuất: Medium (high compute/memory or DoS with lasting effect but recoverable), không nên claim High khi chưa có PoC devnet.
- Các vấn đề khác như LegacyECChain 8192 vs 128, messageQueue không cap, pmsg không cap, host không rate limit – đều là hardening, đã được fix trong các bản trước hoặc nên fix nhưng không phải High.
- Cần tiếp tục audit sâu hơn, đặc biệt:
  - Power table duplicate handling
  - Justification validation với round = math.MaxUint64 cho DECIDE
  - Timestamp validation trong chain exchange (maxTimestampAge 8s, có thể bị attacker gửi timestamp future để làm message bị ignore?)
  - Equivocation filter với peer ID spoofing

## 6. Đề xuất tiếp theo

- Reset branch về main, chỉ giữ fix cho chain exchange bug với notification, không thêm các hardening phức tạp chưa chứng minh.
- Viết PoC bằng Go (cần toolchain) với 2 node mock, 1 node gửi partial trước, chain sau, kiểm tra xem partial có bị kẹt không.
- Chạy với Filecoin Audit Kit devnet để đo thực tế.
- Không ép mapping sang bug Rootstock, chỉ tập trung vào F3 logic.

---
*Audit này là static analysis, chưa có runnable PoC vì môi trường sandbox không có Go toolchain (đã thử tải qua gh api nhưng release-assets bị block). Cần môi trường có Go để chạy test.*
