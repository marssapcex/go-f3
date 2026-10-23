#!/usr/bin/env python3
# DiamondTrading whitepaper builder.
# deps: pip install matplotlib reportlab   (fonts: DejaVu Serif, bundled with matplotlib)
# run:  python build.py  ->  DiamondTrading_v0.2.pdf (+ figures/*.png)
import os, io, math
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIG = os.path.join(HERE, "figures"); os.makedirs(FIG, exist_ok=True)

# ---------- fonts (DejaVu Serif bundled with matplotlib) ----------
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
MPLTTF = os.path.join(os.path.dirname(fm.__file__), "mpl-data", "fonts", "ttf")
pdfmetrics.registerFont(TTFont("Serif",  f"{MPLTTF}/DejaVuSerif.ttf"))
pdfmetrics.registerFont(TTFont("Serif-B",f"{MPLTTF}/DejaVuSerif-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Serif-I",f"{MPLTTF}/DejaVuSerif-Italic.ttf"))
pdfmetrics.registerFont(TTFont("Mono",   f"{MPLTTF}/DejaVuSansMono.ttf"))

SER, SERB, SERI, MONO = "Serif", "Serif-B", "Serif-I", "Mono"

# ================= figures =================
plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                     "figure.dpi": 200, "savefig.bbox": "tight"})

# F1 payoff shapes
fig, ax = plt.subplots(figsize=(5.6, 2.6))
r = np.linspace(-1.2, 1.2, 400)          # relative move in % of strike
digital = np.where(r > 0, 1.0, 0.0)
ramp = np.clip(r / 0.5, 0, 1)
ax.plot(r, digital, lw=2, label="digital ticket (DiamondHouse)")
ax.plot(r, ramp, lw=2, ls="--", label="capped-vanilla ramp (DiamondOptions, band 0.5%)")
ax.set_xlabel("close − strike  (% of strike, direction-adjusted)")
ax.set_ylabel("fraction of max payoff")
ax.legend(frameon=False, fontsize=8); ax.set_ylim(-0.05, 1.1)
fig.savefig(f"{FIG}/f1_payoff.png"); plt.close(fig)

# F2 ceilings vs lambda (measured assets)
ALG = [("BTC",146300),("ETH",108800),("SOL",16200),("HYPE(HL)",4160),("BNB",3760),("SP500(HL)",3710)]
fig, ax = plt.subplots(figsize=(5.6, 2.9))
lam = np.logspace(2, 5, 100)
ax.loglog(lam, 0.25*lam*10/1000, lw=2, label=r"ceiling $\kappa\lambda\omega$, $\omega$=10s, $\kappa$=1/4")
for name, l in ALG:
    ax.scatter([l],[0.25*l*10/1000], zorder=5)
    ax.annotate(name, (l, 0.25*l*10/1000), textcoords="offset points", xytext=(5,4), fontsize=8)
ax.set_xlabel("measured organic flow λ  ($/s, venue-routed)"); ax.set_ylabel("per-position max payout ($k)")
ax.legend(frameon=False, fontsize=8, loc="upper left")
fig.savefig(f"{FIG}/f2_caps.png"); plt.close(fig)

# F3 bust probability vs leverage
def Phi(z): return 0.5*(1+math.erf(z/math.sqrt(2)))
fig, ax = plt.subplots(figsize=(5.6, 2.6))
Ls = np.logspace(0, 3, 200)
for sgm, lab in [(0.0001, "σ=1e-4/s (BTC calm)"), (0.0005, "σ=5e-4/s"), (0.002, "σ=2e-3/s (alt fast)")]:
    pb = [min(0.999, 2*Phi(-(1/L)/(sgm*math.sqrt(60)))) for L in Ls]
    ax.semilogx(Ls, pb, lw=2, label=lab)
ax.set_xlabel("leverage L"); ax.set_ylabel("P(bust within 60 s)")
ax.legend(frameon=False, fontsize=8)
fig.savefig(f"{FIG}/f3_bust.png"); plt.close(fig)

# F4 weight iso-curves sqrt(loss*fees)
fig, ax = plt.subplots(figsize=(5.6, 2.6))
loss = np.linspace(1, 1000, 200); fees = np.linspace(0.1, 100, 200)
Lg, Fg = np.meshgrid(loss, fees)
W = np.sqrt(Lg*Fg)
cs = ax.contour(Lg, Fg, W, levels=[30, 60, 100, 150, 220, 300], linewidths=1.2)
ax.clabel(cs, fmt="w=%d", fontsize=8)
ax.set_xlabel("epoch net loss ($)"); ax.set_ylabel("epoch fees paid ($)")
ax.set_title("iso-weight curves  w = √(loss × fees): doubling weight needs 4× capital", fontsize=9)
fig.savefig(f"{FIG}/f4_weights.png"); plt.close(fig)

# F5 architecture
fig, ax = plt.subplots(figsize=(6.2, 3.1)); ax.axis("off")
def box(x, y, w, h, text, fc="#eef3fb"):
    ax.add_patch(plt.Rectangle((x, y), w, h, fc=fc, ec="#345", lw=1))
    ax.text(x+w/2, y+h/2, text, ha="center", va="center", fontsize=7.6)
box(0.02, 0.70, 0.17, 0.22, "player / LP\n(USDC)")
box(0.28, 0.70, 0.20, 0.22, "quoter (G4 σ, G3 caps,\nρ=2%)  EIP-712")
box(0.57, 0.70, 0.19, 0.22, "attesters 2-of-3\n(G2 TWAP, G8 tol)")
box(0.80, 0.70, 0.18, 0.22, "venues:\nBinance · Hyperliquid")
box(0.24, 0.16, 0.24, 0.30, "DiamondHouse\ntickets 1.05x-1000x\nFIFO queue + QMAX")
box(0.52, 0.16, 0.24, 0.30, "DiamondOptions\n25x capped ramps\nqueue-bounded, attested px")
box(0.02, 0.02, 0.18, 0.20, "EdgeDistributor\nsmart mint v3\nr(e): 200%→30%")
box(0.80, 0.02, 0.18, 0.20, "RevenueSplit\nEDGE stakers\nrev-share")
arr = dict(arrowstyle="->", lw=1.2, color="#345")
ax.annotate("", (0.28, 0.76), (0.19, 0.81), arrowprops=arr)
ax.annotate("", (0.57, 0.76), (0.48, 0.81), arrowprops=arr)
ax.annotate("", (0.80, 0.76), (0.76, 0.81), arrowprops=arr)
ax.annotate("", (0.38, 0.70), (0.38, 0.46), arrowprops=arr)
ax.annotate("", (0.655, 0.70), (0.655, 0.46), arrowprops=arr)
ax.annotate("", (0.24, 0.20), (0.20, 0.13), arrowprops=arr)
ax.annotate("", (0.76, 0.24), (0.80, 0.14), arrowprops=arr)
ax.set_xlim(0,1); ax.set_ylim(0,1)
fig.savefig(f"{FIG}/f5_arch.png"); plt.close(fig)

# ================= document =================
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
                                Image, Table, TableStyle, PageBreak, KeepTogether)
from reportlab.lib import colors

W, H = A4
st_title  = ParagraphStyle("t",  fontName=SERB, fontSize=20, leading=25, alignment=TA_CENTER, spaceAfter=6)
st_sub    = ParagraphStyle("s",  fontName=SERI, fontSize=12.5, leading=16, alignment=TA_CENTER, spaceAfter=10)
st_auth   = ParagraphStyle("a",  fontName=SER,  fontSize=10, leading=14, alignment=TA_CENTER, textColor=colors.HexColor("#333"))
st_abshead= ParagraphStyle("ah", fontName=SERB, fontSize=10.5, leading=13, alignment=TA_CENTER, spaceBefore=8, spaceAfter=4)
st_abs    = ParagraphStyle("ab", fontName=SER,  fontSize=9.5, leading=13.2, alignment=TA_JUSTIFY, leftIndent=14*mm, rightIndent=14*mm)
st_h1     = ParagraphStyle("h1", fontName=SERB, fontSize=13, leading=16, spaceBefore=14, spaceAfter=6)
st_h2     = ParagraphStyle("h2", fontName=SERB, fontSize=11, leading=14, spaceBefore=10, spaceAfter=4)
st_body   = ParagraphStyle("b",  fontName=SER,  fontSize=9.8, leading=13.6, alignment=TA_JUSTIFY, spaceAfter=5)
st_fig    = ParagraphStyle("f",  fontName=SERI, fontSize=8.6, leading=11, alignment=TA_CENTER, spaceBefore=2, spaceAfter=10, textColor=colors.HexColor("#333"))
st_eq     = ParagraphStyle("eq", fontName=SERI, fontSize=10.2, leading=14, alignment=TA_CENTER, spaceBefore=3, spaceAfter=6)
st_mono   = ParagraphStyle("mn", fontName=MONO, fontSize=8, leading=10.5, spaceAfter=6)
st_ref    = ParagraphStyle("rf", fontName=SER,  fontSize=8.6, leading=11.5, spaceAfter=2.5, leftIndent=8*mm, firstLineIndent=-8*mm)
st_tab    = ParagraphStyle("tb", fontName=SER,  fontSize=8.4, leading=10.8)
st_tabb   = ParagraphStyle("tbb",fontName=SERB, fontSize=8.4, leading=10.8)

def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(SERI, 7.5); canvas.setFillColor(colors.HexColor("#555"))
    if doc.page > 1:
        canvas.drawString(18*mm, H-12*mm, "DiamondTrading Research — whitepaper v0.2")
        canvas.drawRightString(W-18*mm, H-12*mm, "October 2026 · working draft")
        canvas.setStrokeColor(colors.HexColor("#999")); canvas.setLineWidth(0.4)
        canvas.line(18*mm, H-13.5*mm, W-18*mm, H-13.5*mm)
    canvas.setFont(SER, 8.5)
    canvas.drawCentredString(W/2, 10*mm, str(doc.page))
    canvas.restoreState()

doc = BaseDocTemplate(os.path.join(HERE, "DiamondTrading_v0.2.pdf"), pagesize=A4,
    leftMargin=19*mm, rightMargin=19*mm, topMargin=20*mm, bottomMargin=16*mm,
    title="DiamondTrading: Solvent-First Turbo Markets", author="DiamondTrading Research")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=header_footer)])

def P(t, s=st_body): return Paragraph(t, s)
def fig(name, w_mm, cap):
    img = Image(f"{FIG}/{name}.png"); r = img.imageHeight / img.imageWidth
    img.drawWidth = w_mm*mm; img.drawHeight = w_mm*mm*r
    return KeepTogether([img, P(cap, st_fig)])
def table(rows, widths, header=True, style_extra=None, fs=8.4):
    data = [[Paragraph(f"<b>{c}</b>", st_tabb) if header and i == 0 else Paragraph(str(c), st_tab)
             for c in row] for i, row in enumerate(rows)]
    t = Table(data, colWidths=[w*mm for w in widths])
    style = [("LINEBELOW", (0,0), (-1,0), 0.7, colors.black) if header else ("LINEABOVE",(0,0),(-1,0),0.7,colors.black),
             ("LINEBELOW", (0,-1), (-1,-1), 0.7, colors.black),
             ("VALIGN", (0,0), (-1,-1), "TOP"),
             ("TOPPADDING", (0,0), (-1,-1), 2.5), ("BOTTOMPADDING", (0,0), (-1,-1), 2.5),
             ("LEFTPADDING", (0,0), (-1,-1), 4), ("RIGHTPADDING", (0,0), (-1,-1), 4)]
    style += style_extra or []
    t.setStyle(TableStyle(style))
    return t

E = []  # story

# ---------- title page ----------
E += [Spacer(1, 26*mm),
      P("DiamondTrading: Queue-Bounded Turbo Markets", st_title),
      P("A Bounded FIFO Payout Queue with a Hard Global Brake, Manipulation-Cost Position Caps,<br/>and Epoch-Decaying Anchored Loss-Mint Tokenomics for 1000x Leveraged Wagering", st_sub),
      Spacer(1, 8*mm),
      P("DiamondTrading Research", st_auth),
      P("Version 0.2 &nbsp;·&nbsp; October 2026 &nbsp;·&nbsp; supersedes v0.1 (full-reserve); implemented and fuzz-verified", st_auth),
      Spacer(1, 10*mm),
      P("Abstract", st_abshead),
      P("Hyper-short-dated leveraged wagering — post margin, drag leverage to 1000x, bust or win within "
        "seconds — reached production scale and then collapsed under its own accounting: the deployed "
        "lineage descending from the Martin Galer queue/emission design accumulated dozens of audit "
        "findings, including outcome-manipulation and mint-accounting exploits [1][2]. v0.1 of this "
        "paper eliminated the queue with full reserves; that correctly prevented debt but meant every "
        "liability was pre-locked, a structure that cannot carry 1000x retail menus. "
        "We present DiamondTrading v0.2, a rebuild that re-admits deferred payment <i>as a bounded, "
        "auditable machine</i> rather than a swamp. <b>Layer one</b> is a queue-bounded payout engine: "
        "profit claims the pool cannot cover become FIFO queue entries backed by a side bucket of "
        "loser stakes; no winner may cut the line; a hard global cap QMAX halts sales the moment "
        "queued debt exceeds it; and a sweep rule guarantees that loser money becomes pool money the "
        "instant the queue is clean — the queue recovers or the product stops, there is no third "
        "state (§4). <b>Layer two</b> is the measurement-driven quoting engine: venue routing by "
        "deepest measurable book, VWAP-of-real-fills settlement anchors, and manipulation-cost "
        "position caps κλω/ω̃ with no treasury terms, since the pool may legitimately be zero (§6). "
        "<b>Layer three</b> is the anchored smart mint: loss rebates are capped at r(e) of a signed "
        "fees-plus-edge anchor, with r(e) decaying 200%→30% over 360 epochs and an absolute epoch "
        "ceiling (§7). The system is implemented — both payout engines, verifiers, tokenomics, and "
        "the off-chain engine — with 95 contract assertions, 41 engine assertions, and five fuzz "
        "seeds that mirror every money lane after every operation (§11). We state the deferred-payment "
        "risk, the attester-quorum trust assumption, and the licensing constraint frankly (§12).", st_abs),
      Spacer(1, 6*mm),
      P("<i>Provenance convention.</i> Every externally checkable claim carries exactly one tag, declared in its "
        "reference entry (§13): <b>[CITED]</b> measured/sourced, <b>[COMPUTED]</b> derived from cited data or the "
        "shipped code, <b>[RECALLED]</b> author's recall of public market structure, <b>[ASSUMED]</b> initial "
        "design parameter (governance-tunable).", st_abs),
      PageBreak()]

# ---------- 1 intro ----------
E += [P("1 &nbsp; Introduction", st_h1),
P("Papertrade demonstrated that the retail gamblers' terminal is not a spot market with leverage "
  "controls; it is a <i>turbo market</i>: margin in, leverage to 1000x, bust price displayed, outcome in "
  "under a minute, plus a token kicker minted on losses that made losing feel like progress. It also "
  "demonstrated the failure mode of building that product on an unbounded solvency queue and gross-loss "
  "emissions: the accountability debt surfaced as 42 audit findings, two of them critical [2]. v0.1 of "
  "this design went to the other extreme — full reserves at sale — which removed the debt and, with it, "
  "the ability to sell the 1000x menus the product exists for. v0.2 keeps the game and <i>rebuilds the "
  "debt as a machine</i>: a FIFO payout queue with a global hard brake (QMAX), a side bucket that "
  "finances the line in the exact order winners arrived, stall refunds that never gate, and a sweep "
  "that ends the bucket the moment the line is clean. The design rule stands: every hazard must be "
  "either (i) impossible to express in code, or (ii) priced and bounded by a measurement, never by a "
  "promise. Deferred payment is declared and bounded — never patched silently."),
P("The remaining text is organized as follows. §2 recalls the lineage and the audit taxonomy we design "
  "against. §3 defines actors, assets, and the trust model. §4 gives the queue-bounded payout "
  "engine and its lane invariant. §5 defines the instruments' payoffs. §6 specifies the GALE off-chain engine (routing, "
  "settlement persistence, caps, breaker, pricer). §7 specifies the smart mint. §8 treats verifiers. "
  "§9 runs the security analysis class by class. §10 covers economics. §11 reports implementation and "
  "test evidence. §12 lists limitations honestly; §13 is the reference and provenance ledger."),
P("2 &nbsp; Lineage and the audit taxonomy", st_h1),
P("<b>Martin Galer (2024-era)</b> introduced the zero-LP bootstrap: queue winners, pay them from later "
  "flow, and emit a token on losses advertised as +EV [1]. Its solvency-ratio invariant was elegant; its "
  "deployment was not. The empirical record: queue and side-bucket accounting exploits (H-01..M-05), "
  "BBO-midpoint outcome manipulation with no deviation or persistence checks (KV-01), straddle-style "
  "short optionality handed to attackers (KV-02), and governance degradable to 1-of-2 signers (L-04) "
  "[2]. Our benchmark in §9 is this taxonomy; a modern turbo market fails by repeating any of it."),
P("<b>Design stance.</b> We copy papertrade's <i>toy</i> (margin, leverage, bust price, seconds, mint on "
  "loss) and re-engineer its <i>machinery</i> so each component has a bound a tester can measure: the "
  "queue is FIFO with a declared ceiling and an external schedule, the side bucket sweeps to pool when "
  "clean, settlement is VWAP-of-fills not midpoints, and insolvency stops sales instead of lying about "
  "them [2][3][4]."),
fig("f1_payoff", 132, "Figure 2 — The two issuance shapes: a digital ticket (pay M·S or 0) and a capped-vanilla ramp (pay intrinsic up to the band). Both reserve the full maximum at sale; neither queues.")]

# ---------- 3 system ----------
E += [KeepTogether([P("3 &nbsp; Actors, assets, trust", st_h1),
table([
 ["actor", "role", "what they can and cannot do [COMPUTED: contract code 5]"],
 ["player", "posts margin, receives tickets", "stake back instantly on any correct claim; profit paid now or via FIFO queue; 24h stall ⇒ permissionless stake refund; pause halts sales only"],
 ["LP", "pool capital backing payouts", "first-loss by construction (pool pays before any queue forms, proven in tests); ≥60% of realized revenue once the seeding target is met [5]"],
 ["quoter", "off-chain pricing engine", "signs quotes (σ-priced, κλω-capped, 30s TTL); cannot settle or move funds; worst-case = bad menus bounded by on-chain class clamps"],
 ["attester set (2-of-3)", "price persistence verification", "cannot settle alone; cannot forge (2 keys); stall ⇒ permissionless stake refund; threshold floored at 2 on-chain"],
 ["budgetAttester", "revenue anchor for the mint budget", "can only lower emissions; cannot touch principal; bonded, rotating"],
 ["owner (governance)", "config + per-class (enabled, maxMult, profitCap)", "global envelope 1.05x–1000x fixed on-chain; production path = Safe 2-of-3 + 7-day timelock [5]"],
], [22, 40, 108])]),
P("Underlyers at launch [3][ASSUMED: menu], per-class enabled/cap/mult governance on-chain: "
  "<b>BTC & ETH — 1000x class</b> (Binance-routed: $12.0–13.1B resp. $8.9–9.9B 24h); "
  "<b>SOL & HYPE — 500x class</b> (SOL Binance-settled at $1.3–1.5B; HYPE Hyperliquid-native, "
  "$327–392M on HL vs $399M Binance); <b>BNB — 200x class</b> (Binance $280–366M); "
  "<b>S&P500 & NASDAQ-100 equity perps — 100x class</b> (Hyperliquid HIP-3 only, ~$310–332M [4]). "
  "Routing per §6.1 [5].", st_body),
fig("f5_arch", 150, "Figure 1 — System map: players post USDC; the quoter prices quotes; attesters verify venue prints; the engines pay now or queue FIFO; the mint and the rev-split close the loop.")]

# ---------- 4 reserve ----------
E += [P("4 &nbsp; The queue-bounded payout engine", st_h1),
P("Let B be the contract's USDC balance. Four accounting lanes partition it: <i>pool</i> (distributable "
  "energy, fed by loser stakes and LP deposits), <i>side</i> (side bucket, loser money that still owes "
  "the queue), <i>open</i> (sum of live stakes), and <i>debt</i> (sum of unpaid queue amounts — debt is "
  "a liability, not cash: it is NOT part of B). The engine maintains at every block:"),
P("<i>B = pool + side + open</i>, &nbsp;&nbsp; <i>debt ≥ 0</i>, &nbsp;&nbsp; <i>(debt = 0) ⇒ (side = 0)</i>", st_eq),
P("Each lane is a first-class storage variable, never derived; <i>lanesIntact()</i> recomputes the "
  "identity after every settlement and every treasury send [5], so a drift between accounting and cash "
  "is loud on-chain, not silent until audit (H-01's habitat was drift discovered months late)."),
P("<b>Sale.</b> A ticket of stake S and maximal profit P<sub>max</sub> may be sold iff (i) the class is "
  "enabled with P<sub>max</sub> ≤ class profit cap, (ii) sales are unpaused, and (iii) <i>debt &lt; "
  "QMAX</i> — the global hard brake (default $1M, owner ceiling $5M) [5]. Nothing about pool size gates "
  "a sale: this is the deliberate bootstrap property v0.1 forfeited. Then <i>open += S</i>; "
  "P<sub>max</sub> reserves nothing, ever."),
P("<b>Settlement of a correct claim</b> returns the stake in full, then pays <i>min(pool, net)</i> "
  "where <i>net = (1−ρ)·profit</i>, ρ=2%. The unpaid remainder <i>u = net − paid</i> — when nonzero — "
  "appends a FIFO queue entry; entry ids are a zero-folded array with a windowed (<i>head, live</i>) "
  "view, so head-trimming frees gas while ids keep ordering [5]. <b>While debt &gt; 0, correct claims "
  "enqueue in full</b> — paying a richer-pool-era newcomer ahead of an older claimant is "
  "unrepresentable: the queue is consulted before any transfer. Lost stakes (KNOCKED) and residual "
  "stakes (EXPIRED, 15% rebated to the buyer, the rest forfeit) route into <i>side</i> when debt &gt; 0, "
  "else into <i>pool</i>. Every settlement then pays up to INLINE_HARVEST=4 queue entries from "
  "<i>side</i> (≈1,950 gas marginal per entry [COMPUTED: §11 probe]); any keeper may call "
  "<i>harvest(1..64)</i> for more, and LP exits refund their live-share pro-rata on the same lane "
  "schedule."),
P("<b>The sweep.</b> When the last entry clears (<i>debt → 0</i>), whatever remains in <i>side</i> "
  "folds into <i>pool</i> in the same transaction [5]. Consequences: (i) loser money becomes pool money "
  "only when nobody is waiting — this is the spec sentence <i>made code</i>; (ii) the bucket cannot "
  "become a parallel shadow treasury — its lifetime is exactly the queue's."),
P("<b>Theorems (fairness and progress).</b> (a) <i>No cut-in-line:</i> queue payments issue only to "
  "entry ids ≥ <i>queueHead</i> in ascending order, and <i>queueHead</i> advances only when the head is "
  "fully paid; hence any two payouts preserve arrival order (property G4, asserted on every fuzz "
  "operation). (b) <i>Recovery-or-stop:</i> when <i>debt ≥ QMAX</i> new sales revert; debt strictly "
  "decreases only via explicit <i>side</i> payments; the state machine can unwind debt or stop new "
  "risk, but can never silently age out a winner's claim (v2 deleted every ticket→claim rekeying "
  "path: what you hold is what asserts). (c) <i>Pause never gates refunds:</i> settle, stall-refund "
  "(24h), harvest, LP-request/all-withdraw flows stay live under pause; only sales and LP deposits "
  "stop [5]. ∎"),
P("<b>Honest accounting note.</b> The ρ=2% fee is a <i>haircut on the player's claim</i>, recorded in "
  "the Settled event for the mint anchor — it never enters pool or side, because when pool &lt; net "
  "that cash does not exist in the contract and inventing it breaks the lane identity. The Options "
  "engine likewise books <i>premium only</i> as house income at settlement; the unpaid slice of maxPay "
  "is a queue-bound liability haircut, not revenue [5].")]

# ---------- 5 instruments ----------
E += [P("5 &nbsp; Instruments", st_h1),
P("A position posts S, picks multiplier M ∈ [1.05x, class max] and direction d ∈ {LONG, SHORT}; the "
  "on-chain envelope spans 1.05x–1000x, capped per class (BTC/ETH 1000x, SOL/HYPE 500x, BNB 200x, "
  "equity perps 100x) [5]. Entry K is the routed venue's trade VWAP over ω=2s at buy; the bust price "
  "is K·(1∓1/M), displayed pre-trade [ASSUMED: ω]. Three attested outcomes at expiry τ ∈ [30s, 300s]: "
  "<b>WON</b> (correct direction) returns stake + profit(M,S,close) with ρ shaved off profit; the cash "
  "schedule of §4 applies (pool now, rest FIFO). <b>KNOCKED</b> (wrong direction): stake forfeits to "
  "side-or-pool. <b>EXPIRED</b> (boundary): 15% stake rebate, rest forfeits; settlement is refused "
  "before expiry so band-β pool readings are always post-close [5]. Two shapes share the schedule:"),
table([
 ["shape", "payoff at close C", "contract"],
 ["digital ticket", "stake S back + full profit (M−1)·S − ρ when correct, else forfeit", "DiamondHouse"],
 ["capped-vanilla ramp", "stake S back + ramp profit (M−1)·S · min(|C−K|, band·K)/(band·K) − ρ", "DiamondOptions"],
], [34, 96, 40]),
P("The ramp is the options-flavoured mode: band = strike-relative cap, premium-funded, maxPay "
  "class-capped; house income is the premium only (§4 note). Graded wins keep engagement at sane "
  "multipliers; the digital shape is the papertrade-exact bust loop. Neither shape escrows winnings "
  "at sale — that is exactly the bootstrap property — and both bind to the same FIFO machinery."),
P("6 &nbsp; The GALE engine", st_h1),
P("6.1 &nbsp; Venue routing (G1)", st_h2),
P("Asset a routes to the venue maximizing measurable depth within the ticket band, re-scored at 5s "
  "cadence across Binance (spot+futures) and Hyperliquid (WSS; L1Read proofs later) [ASSUMED: cadence]. "
  "Measured 24h quote volumes (Binance + HL, Oct 2026 [3][4]) drove launch routing: BTC $12.0–13.1B "
  "vs HL $2.3–3.0B and ETH $8.9–9.9B vs HL $0.7–0.9B → majors single-read on Binance; SOL $1.3–1.5B "
  "vs HL $125–152M → Binance-settled; BNB $280–366M → Binance; HYPE ~$0.40B Binance vs $327–392M HL → "
  "Hyperliquid stays its native home; S&P500 / NASDAQ-100 (HIP-3) exist only on HL at $310–332M → "
  "HL-only with κ=1/4 [3][4]. Additional venues re-enter only after runtime measurement: the launch "
  "router is two-venue by choice, not by default [3].")]

E += [P("6.2 &nbsp; Settlement persistence (G2)", st_h2),
P("Never midpoints. Both anchors are volume-weighted means of <i>real fills</i> over their ω windows: "
  "VWAP(t) = Σ p<sub>i</sub>q<sub>i</sub> / Σ q<sub>i</sub> over [t−ω, t]; an empty window yields "
  "NO-PRINT, an honest failure that routes to re-attestation or stake refund, never to a guessed price "
  "[COMPUTED: engine spec 6]. Forging a persistent print costs real executed volume through the whole "
  "window — the KV-01 class (midpoint twitch) is gone by construction [2]."),
P("6.3 &nbsp; Manipulation-cost position caps (G3)", st_h2),
P("The attack that matters: dominate the settlement reference over its measurement window. Its cost is "
  "lower-bounded by organic flow λ<sub>a</sub>·ω with λ<sub>a</sub> the routed venue's measured 24h "
  "quote volume per second (EMA-smoothed, floored at its 10th percentile) [ASSUMED: estimator]. The "
  "per-position maximal payout obeys:"),
P("P<sub>max</sub>(a,ω) = min( κ·λ<sub>a</sub>·ω/ω̃, &nbsp;classCap<sub>a</sub> ), &nbsp;&nbsp; ω̃ = 10s reference", st_eq),
P("with κ = 1/4 single-read and 1/3 dual-read (an attacker must move both venues to pass G8) "
  "[ASSUMED: κ]. Note what is absent: no treasury term. v0.1's T/60 and 0.3T treasuries measured what "
  "the vault could afford; under queue-bounded bootstrap the pool may legitimately be zero, so the "
  "honest ceiling is what the <i>market</i> can cost an attacker — plus the static on-chain class "
  "cap as outer wall (G3 only tightens). The ceiling collapses automatically in thin sessions: "
  "off-hours equity perps shrink toward zero without human scheduling. Figure 2 plots launch ceilings "
  "against measured λ [3][4]."),
fig("f2_caps", 132, "Figure 3 — Per-position profit ceiling κλω (ω=10s) vs measured organic flow, launch assets annotated (log-log; Oct-23 λ). On-chain class caps are the static wall; G3 can only tighten."),
P("6.4 &nbsp; Vol-spike breaker (G4)", st_h2),
P("If realized σ over 30s exceeds 4× the 30-day median, the quoter stops signing for 60s on that asset "
  "[ASSUMED]. In-flight quotes die by their ≤30s TTL on-chain [5]. Stale-quote sniping around macro "
  "prints — the standard ticket-shop harvest — has no window."),
P("6.5 &nbsp; Pricer: fair multiplier from measured σ, shaved by ρ", st_h2),
P("For a zero-drift price, first passage to the ∓1/L barrier within τ is approximately, by the "
  "reflection principle:"),
P("P<sub>bust</sub>(L,σ,τ) ≈ 2·Φ( −(1/L) / (σ√τ) ),&nbsp;&nbsp; M<sub>fair</sub> = 1/(1−P<sub>bust</sub>),&nbsp;&nbsp; M<sub>offer</sub> = M<sub>fair</sub>·(1−ρ)", st_eq),
P("with ρ = 2% the published house edge [ASSUMED: pricing rule]. Offers clamp to the on-chain envelope "
  "(1.05x–1000x, per-class tighter) and refuse when the fair multiplier is below the floor — the engine "
  "does not sell products it cannot price honestly [5][6]. Figure 4 shows the bust surface."),
fig("f3_bust", 132, "Figure 4 — Bust probability vs leverage for three volatility regimes (τ=60s; reflection-principle model). The menu lives where the curves are informative; extreme L converges to coin-flip and is priced as such."),
P("Why 2% is affordable where competitors take 4–6% [RECALLED: market range]: G2+G4 strip the "
  "adverse-selection tax (toxic flow is the cost driver in turbo books), G3 bounds the tail per "
  "position, and the mint rebate returns part of the edge to losers — making the product cheaper on "
  "sticker <i>and</i> in expectation [COMPUTED: from the design above].")]

# ---------- 7 mint ----------
E += [P("7 &nbsp; Smart-mint v3: emissions losers cannot farm, decaying to schedule", st_h1),
P("Loss-minting is the retention engine and was the original protocol's exploit surface. The v3 mint "
  "keeps the emotion (losing earns), removes the farm, and — new in v0.2 — <i>decays its allowance on "
  "a public schedule</i> so boot can be generous without promising it forever:"),
table([
 ["defense", "rule", "consequence"],
 ["net-loss epochs", "weight base = max(0, Σstake − Σpayout) per address per 6h epoch", "win-then-lose cycles cannot manufacture mintable losses"],
 ["fee-squared weight", "w = √(netLoss · feesPaid) × loyalty (1.25 if staked EDGE)", "mint requires real rake; √ forces 4× capital for 2× weight"],
 ["honest anchor", "anchor = Σ fees(user-haircuts) + Σ realized edge, signed by budgetAttester (USDC 1e6)", "budget reflects money that actually moved, not projections [5]"],
 ["decaying schedule", "budget ≤ r(e)·anchor/p(e); r(e) = max(30%, 200%−170%·e/360) linear", "early epochs rich (200%), the curve cools to a 30% annuity and cannot be revived [COMPUTED]"],
 ["hard ceiling", "mint ≤ epochCap per epoch (default 2M EDGE, ceiling 5M, lowerable, never raisable)", "sybils split a fixed pie; pro-rata yields no scale [COMPUTED]"],
], [30, 76, 64]),
P("The merkle distributor enforces the schedule on-chain against the signed anchor — EIP-191 over "
  "(epochId, anchor, priceX1e8). Price p(e) has no on-chain reference until EDGE transfers open, so the "
  "attester signs it; the bootstrap policy is p(e) ≈ $0.01·0.995^e, TWAP-chained once public "
  "transferability exists. Anchors signed under a different domain/branding are rejected by the "
  "on-chain identity probe [5]. EdgeToken itself boots non-transferable (allowlist-only moves for "
  "sink/staking contracts); public transfer is a one-way flag flipped after launch liquidity criteria "
  "are met, never re-lockable [5]. Weights are computed in the engine ledger [6]; root/post/claim is "
  "covered end to end (§11). EDGE carries cashflow via RevenueSplit (pull-only notifyRevenue; claims "
  "reconciled by cumulative-index snapshots, never live deltas), which is what makes an asset handed "
  "out on losses worth holding instead of dumping."),
fig("f4_weights", 128, "Figure 5 — Iso-weight curves of w=√(loss·fees): weight grows sub-linearly in both inputs, so scale buys nothing and only sustained, rake-paying participation accumulates emission share."),
P("8 &nbsp; Verifiers and the endgame", st_h1),
P("Settlement inputs are M-of-N EIP-712 attestations (default 2-of-3; the threshold setter is "
  "hard-floored at 2 on-chain — L-04 cannot recur) [5]. Attesters each read the routed venue's trade "
  "tape independently; dual-listed assets require the two venues' prints within 12bp before anyone "
  "signs, so manipulation must succeed on two venues simultaneously to extract and on neither merely to "
  "void tickets into refunds [ASSUMED: tolerance][COMPUTED: engine]. Anyone may relay a passing proof; "
  "no attester can settle alone, block settlement, or fake a stall. If all attesters stall for 24h, "
  "every live position unwinds to its stake permissionlessly [5]. The stated endgame is a verifier "
  "reading HyperEVM L1Read trade-print state directly — deleting attesters from the path for "
  "HL-routed assets — behind the same IOutcomeVerifier interface already implemented [5]."),
P("9 &nbsp; Security analysis", st_h1),
P("Method: replay the audit taxonomy of record [2] and ask for each class whether it exists here."),
table([
 ["exploit class (Guardian id)", "their habitat", "status here", "mechanism"],
 ["payout queue / side-bucket accounting (H-01..M-05)", "queue vs ledger divergence", "contained", "FIFO + QMAX brake; lanesIntact() asserted after every mutation; sweep ends the bucket when clean (§4)"],
 ["BBO-midpoint settlement (KV-01)", "single-source midpoint", "absent", "VWAP persistence G2 + 2-of-3 tolerance (1bp) G8"],
 ["short optionality / straddle (KV-02)", "unpriced option grants", "bounded", "payout shapes closed-form; class clamps on-chain; no free bands"],
 ["unconstrained bet sizing (M-02/05)", "flat caps vs flow", "closed", "G3 κλω/ω̃ dynamic caps + on-chain class profit caps (§6.3)"],
 ["gross-mint / mint accounting (KV-04)", "loss-mint farming", "closed", "net-epoch √-weights + r(e)-schedule on signed anchor + absolute epoch cap (§7)"],
 ["keeper/governance capture (L-04, I-20)", "1-of-2, timelock→0", "closed", "threshold floor 2 on-chain; owner→Safe+7d timelock; pause = sales/deposits only"],
 ["stale settlement / trapped funds (L-11)", "keeper stall", "closed", "24h permissionless refund; pause never gates refunds/harvest"],
 ["quote replay / intent abuse (KV-14)", "WESig re-use", "closed", "buyer-bound EIP-712 + ≤30s TTL + worst-bounds; replay economically neutral; wrong-domain sigs rejected (probed)"],
 ["liquidity-honest bootstrap (new)", "silent insolvency", "closed", "sales halt at QMAX debt; claims never expire; debt decrease only by side-bucket FIFO payments (§4)"],
], [42, 38, 24, 66]),
P("Residual risks, stated: attester liveness/collusion above floor (mitigated, not eliminated); "
  "κλω is a bound, not a proof of manipulation cost (books can thin faster than flow); equity-perp "
  "single-venue windows degrade G8 to single-read; the quoter's strike/σ inputs are trusted within "
  "clamp bounds [12]. Each has a named on-chain failsafe; none is silent.")]

# ---------- 10 econ ----------
E += [P("10 &nbsp; Economics", st_h1),
P("Revenue waterfall on realized edge, gated by queue health [5]: distributable = (pool − "
  "TARGET_POOL) × 80%, computable only when the queue is fully clean (debt = 0 ∧ side = 0 — a payout "
  "crisis diverts 100% of flow to solvency, none to distributions). Of each distribution: ≥60% goes "
  "LP-claim on a pro-rata cumulative index (permissionless claimLP — the LP floor is code, not policy), "
  "and the remainder funds the mint budget anchor + staker rev-share + operations [5][ASSUMED]. LPs "
  "underwrite variance in exchange for the majority share and are provably first-loss: the pool pays "
  "winners before any queue exists, and exits settle pro-rata against the actual pool [5][6]. The "
  "growth loop: queue-cleared epochs mint rebates that convert losers into EDGE stakeholders; staker "
  "rev-share aligns the losing-but-loyal cohort with house health; cheaper published edge (ρ=2%) plus "
  "graded ramp wins drive flow; flow deepens LP returns and the λ-derived caps that permit larger "
  "honest tickets."),
P("Fee stance versus incumbents: one number, ρ = 2%, published, no deposit/withdrawal/turnover fees "
  "[ASSUMED]. The competitive claim is arithmetic, not adjectives: at equal flow, a toxic-flow tax "
  "removed by G2/G4 funds the price cut."),
P("11 &nbsp; Implementation status and evidence", st_h1),
table([
 ["component", "artifact", "evidence"],
 ["payout engines", "DiamondHouse, DiamondOptions (queue-bounded) [5]", "95/95 contract assertions green: FIFO ordering, exact-debt partials, inline harvest, sweep-on-clean, QMAX stop-sales, stall refunds, EXPIRED rebate timing, lane identity B = pool+side+open"],
 ["verifiers", "MultiAttesterVerifier, MultiPriceVerifier [5]", "2-of-3, floor-2, 1bp tolerance paths, wrong-domain signature probes"],
 ["tokenomics", "EdgeDistributor (r(e)-schedule + anchor EIP-191), RevenueSplit (pull-only notify), EdgeToken (bootstrap lock, one-way enable) [5]", "r(e) 200%→30% decay, cap clamp, anchor mis-sign rejected, domain-mismatch rejected, double-claim blocked, transfer guard (4-path probe) tested"],
 ["engine", "engine/ (venues, caps, pricer, quoter, attester, ledger) [6]", "41/41 assertions incl. ganache interop: engine-signed quotes sell, engine attestations settle, engine merkle posts/claims on-chain; caps carry no treasury terms"],
 ["fuzzing", "property fuzz, 150-op seeds 1337/7/42/90210/555", "167–177 lane checks per seed, all green; queues up to $148k debt exercised; FIFO payments observed 6–16× per seed"],
], [40, 70, 60]),
P("12 &nbsp; Limitations (the honest page)", st_h1),
P("(i) <b>Deferred payment is a real risk by construction.</b> queue-bounded payout means winners may "
  "legitimately wait; debt is extinguished only by side-bucket FIFO payments (loser flow) or LP "
  "backfill, and sales stop at QMAX — that is recovery, not guarantee. Every claim is permanent, "
  "order-preserving, and undeniable, but timing is a market variable. (ii) Settlement is "
  "attester-quorum, not cryptographic trade-print proof; the L1Read verifier is the largest open "
  "item. (iii) The collared σ inputs come from the quoter within clamp bounds; dual-print anchored "
  "strikes are specified, not shipped. (iv) κλω is a lower bound assembled from estimator assumptions; "
  "stress may invalidate the estimator faster than the breaker reacts. (v) Equity perps trade 24/7 on "
  "one venue; off-hours is handled by cap decay plus a quoter curfew, both [ASSUMED]. (vi) EDGE's "
  "bootstrap is non-transferable by design until a one-way flag; hold-horizon risk is declared. "
  "(vii) Regulatory: an offshore, unlicensed distribution of this product scores zero on a three-year "
  "horizon; licensing (or licensing-grade geofencing) is a launch gate, not a growth item [ASSUMED]."),
P("13 &nbsp; References and provenance ledger", st_h1),
P("[1] [CITED: Martin Galer whitepaper, docs.papertrade.xyz, fetched Oct 2026] queue-based payout "
  "bootstrap, solvency-ratio invariant, loss-emissions.", st_ref),
P("[2] [CITED: Guardian Security Review of Papertrade Protocol, final report Oct 10 2026] 42 findings; "
  "KV/H/M/L ids as used throughout this paper.", st_ref),
P("[3] [CITED: api.binance.vision snapshots fetched 2026-10-22 + user-provided Binance 24h reads 2026-10-23; Bybit evaluated + dropped (geo-blocked)] "
  "spot depths/24h volumes in research/LIQUIDITY.md.", st_ref),
P("[4] [CITED: user-provided Hyperliquid screenshots, app.hyperliquid.xyz, 2026-10-20] HYPE OI/volume, "
  "market list incl. HIP-3 equity perps.", st_ref),
P("[5] [COMPUTED: diamondtrading/contracts/ DiamondHouse.sol, DiamondOptions.sol, Verifiers.sol, "
  "EdgeDistributor.sol, EdgeToken.sol, RevenueSplit.sol — this repository] all on-chain behavior cited above.", st_ref),
P("[6] [COMPUTED: diamondtrading/engine/ + test/engine.test.js + test/fuzz.js — this repository] engine behavior cited above.", st_ref),
P("[7+] [ASSUMED]/[RECALLED] parameters (κ, ω, ρ, tolerances, splits, curfews, market fee ranges) as "
  "marked inline.", st_ref),
Spacer(1, 4*mm),
P("TÓM TẮT — bản tiếng Việt", st_h1),
P("DiamondTrading v0.2 là sàn turbo kiểu papertrade (nạp margin, đòn bẩy đến 1000x ở BTC/ETH, biết giá "
  "bust trước khi bấm, thắng thua trong 30–300 giây, thua được mint EDGE) được dựng lại từ nền: "
  "(1) tiền thắng trả ngay từ pool, phần chưa đủ vào hàng đợi FIFO — không ai được vượt hàng, nợ chạm "
  "trần QMAX thì sàn ngừng bán vé mới, tiền thua chỉ thành tiền pool khi hàng đợi sạch (lệnh sweep "
  "trong cùng giao dịch); (2) giá settle là VWAP của lệnh khớp thật trên sàn sâu nhất từng tài sản "
  "(BTC/ETH/SOL/BNB đi Binance; HYPE đi Hyperliquid; S&P500/NASDAQ100 chỉ có trên HL HIP-3); trần "
  "lệnh = min(κλω, cap lớp on-chain) — không còn giới hạn theo treasury vì pool được phép bằng 0 lúc "
  "khởi động; (3) mint khi thua nhưng chống farm: lỗ ròng theo epoch, trọng số √(lỗ × phí) × hệ số "
  "trung thành, ngân sách = r(e) × doanh thu thật có chữ ký, r(e) giảm tuyến tính 200% → 30% trong "
  "360 epoch và không ai tăng ngược được, trần tuyệt đối 2M EDGE/epoch; (4) phí công khai 2% khấu trừ "
  "trên phần thắng; (5) EDGE khóa chuyển giao trong bootstrap, mở một chiều sau khi đủ thanh khoản, "
  "stake EDGE được chia doanh thu. Bộ kiểm thử xanh toàn phần: 95 kiểm chứng hợp đồng, 41 kiểm chứng "
  "engine, fuzz 5 seed × ~170 bất biến. Rủi ro được khai báo thẳng: trả chậm là có thật khi queue kẹt "
  "(claim không mất, chỉ chờ), attester 2-trong-3 vẫn là điểm tin cậy, và điều kiện pháp lý là cổng "
  "ra mắt chứ không phải việc để sau.", st_body)]

doc.build(E)
print("PDF built:", os.path.getsize(os.path.join(HERE, "DiamondTrading_v0.2.pdf")), "bytes")
