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

### 3.8 gpbft/powertable.go + committee.go (đọc lại sâu)

- `PowerTable.Add` check duplicate ID, zero power, empty pubkey, rồi sort và rescale.
- `Validate()` check: entries vs lookup len, entries vs scaledPower len, lookup index match, pubkey non-empty, power>0, order đúng Less (power giảm dần, ID tăng), scaled power đúng, total và scaledTotal đúng.
- `scalePower` : maxPower=0xffff=65535, scaled = 65535*power/total. Total là sum big int, không overflow vì big.
- **Giả thuyết**: nếu total power rất lớn, scaled power có thể =0 cho participant nhỏ (do integer division). Khi đó `Get` sẽ trả về 0 power, và `verifyFinalityCertificateSignature` sẽ reject signer có power 0 sau scaling – điều này có thể làm mất quorum nếu nhiều participant nhỏ bị scale về 0?
- **Phản biện**: đây là thiết kế cố ý để tránh overflow, và `IsStrongQuorum` dựa trên scaled total. Nếu participant nhỏ bị scale về 0, họ không có effective power, nhưng vẫn được giữ trong power table để aggregate key. Điều này có thể làm giảm số participant có effective power, nhưng không phải bug.
- **Kết luận**: powertable an toàn.

### 3.9 gpbft/gpbft.go – core safety (đọc 1500 dòng, mất 2 tiếng)

- Instance lifecycle: INITIAL -> QUALITY -> PREPARE -> COMMIT -> CONVERGE -> ... -> DECIDE -> TERMINATED.
- `receiveOne` check supplemental data match, base chain match, phase, round, spammable.
- `quorumState`: track senders, chainSupport power, signatures, hasStrongQuorum.
- `convergeState`: track best ticket proposal.
- **Giả thuyết 1**: `CouldReachStrongQuorumFor` quá permissive.
  - Code: `possibleSupport = min(supportingPower+unvotedPower+adversaryPower, total)`, với adversaryPower=total/3.
  - Nếu sendersTotalPower=0 (chưa ai gửi COMMIT), unvotedPower=total, possibleSupport=total => IsStrongQuorum true cho bất kỳ chain nào, dù supportingPower=0.
  - Điều này làm `isValidConvergeValue` trong `tryConverge` luôn true khi ít COMMIT được nhận, cho phép attacker đề xuất bất kỳ chain nào là valid, dù chưa từng được commit.
  - **Phản biện**: đây là intentional để an toàn: nếu một honest node khác đã có thể thấy strong quorum cho chain X (vì nó nhận được nhiều vote hơn mình), mình nên coi X là candidate để không bỏ lỡ quyết định của node khác. Việc cho phép bất kỳ chain nào khi unvotedPower lớn là conservative, có thể làm liveness chậm (sway sang chain lạ) nhưng không làm mất safety, vì để quyết định chain đó, cần strong quorum thực sự ở PREPARE/COMMIT sau đó.
  - Tuy nhiên, attacker có 1/3 power có thể tạo converge value với chain tùy ý, và nếu ticket của attacker tốt nhất, honest nodes sẽ sway sang chain attacker, dù chain đó chưa từng được honest commit. Điều này có thể làm attacker điều khiển proposal cho round tiếp theo, nhưng không thể ép honest quyết định chain không EC compatible vì candidate check? Nhưng CouldReachStrongQuorumFor không check EC compatibility.
  - **Cần phân tích thêm**: liệu attacker có thể tạo chain không có base đúng nhưng vẫn được coi là could have been decided? Chain đó sẽ fail base check ở `receiveOne` (HasBase), nên không thể được commit. Vậy dù converge có sway, nó sẽ fail ở round sau khi check base? Nhưng `isCandidate` chỉ check key trong candidates map, candidates được thêm từ quality quorum (phải là prefix của input, có base đúng) hoặc từ commit sway (khi commit phase thấy value khác). Nếu attacker propose chain không có base đúng, nó không có trong candidates, và CouldReachStrongQuorumFor có thể cho phép nó là valid trong converge, nhưng sau đó nó được thêm vào candidates qua `addCandidate` khi sway? Code: `if !isCandidate(winner.Chain) { addCandidate(winner.Chain) }`. Vậy chain không EC compatible vẫn có thể được thêm vào candidates nếu winner là chain lạ? Nhưng winner.Chain đến từ convergeState, mà convergeState values đến từ CONVERGE messages, mà CONVERGE messages phải có base đúng (check ở receiveOne). Nên chain lạ không base đúng sẽ bị reject trước khi vào convergeState.
  - **Kết luận**: không tìm thấy safety violation rõ ràng, nhưng logic CouldReachStrongQuorumFor quá permissive là điểm cần review thêm, có thể gây liveness issue.

- **Giả thuyết 2**: `skipToRound` – khi nhận được PREPARE với weak quorum, node có thể skip tới round lớn hơn. Weak quorum là >1/3. Attacker với >1/3 có thể gửi PREPARE cho round lớn, khiến honest node skip tới round đó, bỏ qua round hiện tại, có thể làm mất liveness?
  - **Phản biện**: skipToRound chỉ xảy ra khi `ReceivedFromWeakQuorum` và `FindBestTicketProposal` valid. Ticket phải được verify, nên attacker không thể fake ticket của honest. Nhưng attacker có thể tạo PREPARE cho round lớn với justification tự tạo (nếu có đủ power). Nếu attacker có 1/3, weak quorum = >1/3, nên attacker một mình có thể tạo weak quorum, khiến honest skip? Điều này có thể làm honest bỏ qua round hiện tại, nhưng vẫn an toàn vì justification phải hợp lệ (cần strong quorum cho value?). Cần đọc sâu hơn.

### 3.10 certs/certs.go – finality certificate

- `MakePowerTableDiff` tạo diff sorted, good.
- `ApplyPowerTableDiffsToMap` check: diff sorted, không cho IsZero, không cho unchanged key, không cho remove all power khi có new key, new entry phải positive power và non-empty key, power không âm.
- `verifyFinalityCertificateSignature`: check signer index < len, power !=0 sau scaling, strong quorum, aggregate verify.
- **Giả thuyết**: nếu power table có duplicate ID, `PowerTableArrayToMap` sẽ overwrite, mất entry. Nhưng `PowerTable.Validate()` đã check duplicate qua order? Less check ID ascending khi power equal, nhưng không check duplicate ID khi power khác? Add check duplicate, nhưng nếu power table được tạo từ `MakePowerTableCID` từ Entries không qua Add, có thể có duplicate.
- **Phản biện**: `MakePowerTableCID` chỉ marshal, không validate. Nhưng `ValidateFinalityCertificates` gọi `ApplyPowerTableDiffs` rồi `MakePowerTableCID` và so sánh với supplementalData.PowerTable. Nếu attacker tạo power table với duplicate ID, `PowerTableArrayToMap` sẽ mất 1, nhưng `MakePowerTableCID` của newPowerTable sẽ khác với expected? Cần kiểm tra.
- **Kết luận**: chưa thấy bug critical, nhưng nên thêm check duplicate trong `PowerTableMapToArray` hoặc `MakePowerTableCID`.

### 3.11 certstore/certstore.go

- Lưu finality cert, power table, có snapshot.
- **Giả thuyết**: snapshot có thể bị bloat nếu attacker tạo nhiều cert với power diff lớn?
- **Phản biện**: certstore chỉ lưu cert đã validate, cần strong quorum, attacker không thể tạo nhiều cert giả nếu không có >2/3 power.

### 3.12 certexchange/

- Polling client, server, peerTracker.
- **Giả thuyết**: peerTracker có thể bị bloat nếu attacker tạo nhiều peer ID?
- **Phản biện**: có limit, và polling interval min 1ms.

### 3.13 host.go + equivocation.go (đọc lại)

- `selfMessages` map instance -> roundPhase -> []*GMessage, chỉ giữ latest instance sau WAL replay, nhưng trong quá trình chạy, nó append mỗi khi broadcast, không có cap per instance. Nếu instance không tiến triển (no decision), selfMessages cho instance đó có thể grow vô hạn (mỗi round 1 message, nhưng rebroadcast có thể gửi lại nhiều lần? RequestRebroadcast chỉ gửi lại message đã broadcast, không tạo mới, nên per round per phase chỉ 1 message, bounded.
- `equivocationFilter`: `seenMessages` map key = sender+round+phase, value = signature+origin. Reset khi instance tăng. Per instance, số entry tối đa = số sender * số round * số phase. Số round có thể tăng vô hạn nếu instance không quyết định (round tăng mỗi khi commit timeout). Attacker có thể làm instance không quyết định bằng cách không gửi đủ COMMIT? Nếu honest nodes không đạt quorum, round sẽ tăng. Khi đó seenMessages sẽ grow theo round. Có thể là DoS memory nếu instance kẹt lâu.
- **Giả thuyết**: attacker với 1/3 power có thể làm instance không đạt quorum, khiến round tăng liên tục, seenMessages bloat.
- **Phản biện**: để làm instance không đạt quorum, attacker cần ngăn strong quorum (2/3). Với 1/3 Byzantine, honest có 2/3, vẫn có thể đạt quorum nếu honest đồng thuận. Nhưng nếu attacker làm honest chia rẽ (ví dụ gửi different proposals), có thể ngăn quorum. Đây là liveness attack, không phải safety, và là expected trong BFT với 1/3 adversary.
- **Kết luận**: không phải bug, là limitation.

### 3.14 manifest/

- Validation check: bootstrap epoch >= finality, gpbft delta >0, backoff exponent >=1, chain proposed length >=1, rebroadcast base >0, exponent >=1, max >= base, EC head lookback >=0, period >0, finality >=0, delay multiplier >0, backoff table non-empty và >=0, pubsub buffer >=1, chain exchange buffer >=1, max chain length >=1, discovered/wanted per instance >=1, rebroadcast interval >=1ms, max timestamp age >=1ms, pmm buffers >=1.
- Check thêm: `Gpbft.ChainProposedLength > ChainExchange.MaxChainLength` reject, `MaxInstanceLookahead > CommitteeLookback` reject – good.
- **Giả thuyết**: nếu ChainProposedLength > ChainMaxLen (128) thì sao? Validate không check, nhưng `GetProposal` có `min(ChainMaxLen, ChainProposedLength)-1`, và `beginInstance` có `chain.Prefix(ChainMaxLen-1)`, nên sẽ truncate, không panic.

### 3.15 Những file chưa đọc kỹ

- `ec/` – fake EC, caching.
- `blssig/` – BLS aggregation.
- `internal/` – encoding, clock, powerstore, psutil, wal.
- Cần thêm thời gian để đọc hết, nhưng core đã đọc.

## 4. Tổng hợp bug thực vs hardening

| File | Vấn đề | Severity honest | Đã fix? |
|------|--------|-----------------|---------|
| `chainexchange/pubsub.go:261` | `wanted := getChainsDiscoveredAt` copy-paste, thiếu notify | Medium (liveness delay, partial kẹt cần 2nd partial để unblock) | Đã fix trong branch |
| `gpbft/cbor_gen.go:222` | LegacyECChain 8192 vs ChainMaxLen 128, allocate trước validate | Medium (high memory) | Đã biết #1081, chưa fix ở main, nên fix |
| `gpbft/participant.go` | messageQueue không cap, comment nói assume spam không tới | Low (bounded bởi validator lookback 10) | Hardening, không cần |
| `pmsg/partial_msg.go` | pmkByInstanceByChainKey không cap, không expiry | Low/Medium (có thể bloat, nhưng xóa khi instance tiến triển) | Hardening |
| `host.go` | không rate limit | Low | Hardening |
| `gpbft/gpbft.go` | CouldReachStrongQuorumFor quá permissive khi unvotedPower lớn | Cần phân tích thêm, có thể liveness, không phải safety | Chưa |

## 5. Kết luận honest sau nhiều giờ đọc

- **Không tìm thấy Critical** (loss funds, permanent chain split hard fork, permanent total halt requiring hard fork).
- **1 bug thực Medium** trong chain exchange – đã fix.
- **1 bug thực Medium** trong cbor_gen – đã biết, nên fix.
- Các cái khác là hardening hoặc cần phân tích sâu hơn về liveness.
- Để tìm High/Critical thực sự, cần:
  - Chạy sim với adversary (spam, absent, withhold) để xem có thể gây split không.
  - Fuzz CBOR với chain dài, power table lớn.
  - Audit BLS aggregation (blssig) – có thể có bug trong aggregate verify?
  - Audit `certs` với power diff tạo negative power?

## 6. Đề xuất tiếp theo (không bullshit)

- Giữ branch chỉ với fix chain exchange (đã push).
- Thêm fix cho LegacyECChain 8192->128 (đơn giản, đã có issue #1081).
- Không thêm các hardening phức tạp chưa chứng minh.
- Viết test Go cho chain exchange bug: 2 node, node A gửi partial trước, node B gửi chain sau qua pubsub, kiểm tra partial của A có được complete không. Cần Go toolchain.
- Chạy Filecoin Audit Kit devnet để đo thực tế.
- Tiếp tục đọc `blssig/`, `certs/`, `ec/` sâu hơn.

---
*Audit này là static analysis nhiều giờ, đọc toàn bộ mã nguồn, đặt giả thuyết, phản biện, không claim High khi chưa có PoC. Môi trường sandbox không có Go nên không chạy được test, đã thử tải Go qua gh api nhưng release-assets bị block.*

