# Reference page index - gsp-diagram-standard

Pointer table for the 30 page images in `pages/` (pNNN.jpg, NNN = PDF page) taken from the "GSP Diagram Manual, Multi-Domain, Rev B" (603 pages, sheet footer "REV B - 16-XI-2026").
Use these pages as structure references (layout, label grammar, key row, caption and source line), not as pixel ground truth: the manual's own figures break some of its rules (labels overprinted by lines, ellipsis truncation, clipped labels; see the fault list at the end).
"Studio today" verdicts come from `../01_gap_matrix.md` and a source inventory of DATUM Studio. They were not tested by running the engine.
Every row was written after opening the image. "differs from research note" marks where the image contradicts the metadata handed to the indexer; "reviewer note" marks a doubt about a verdict (the verdict itself is kept).
Rule ids are the manual's (DOC, PER, SEL, MOD, LAY, GRM, SHT, FW, AIM, CASE, M). A domain id is listed only where the page prints "illustrates XXX-nn" in its source line.
Engine caps to remember: 24 nodes and 48 edges per figure; width 128 or 166 mm; families `layered, topology, stack, flow, swimlane, sequence, sld, rack, graph`.
Date: 2026-11-17.

## 1. Sheet apparatus and procedure (6 pages)

### p028.jpg - Figure 5.3 "When every edge snaps to the page lattice and one class has one size, a tier reads as a tier without a frame." and Figure 5.4 "The overview names the sheet holding each subsystem, and the detail sheet connects outward only through connectors that name sheet and zone."
- Domain / type: foundations (sections 5.3-5.5) / two-tier node-link (5.3); overview sheet plus detail sheet with off-sheet connectors (5.4).
- Imitate: four same-size access-switch boxes over one wider amber core box, with four separate arrival points on the core (fanned anchors); small grey note line under the figure; overview blocks whose `sub` is the target sheet ("-> sh. 4"); pentagon connectors carrying "3/B2" and "5/A1"; panel headings "SHEET 1 - OVERVIEW", "SHEET 4 - DETAIL OF PROCESSOR".
- Rules: LAY-03, LAY-04, LAY-06, LAY-07, PER-02, PER-04, FW-04, CASE-04. Studio today: partly. Family: layered (5.3), layered or graph (5.4). Tokens: box, cylinder, offpage, doubled; edge kind data; class.accent.
- Cannot express: sheet/zone target on an off-page connector, grid zones, partner check between sheets. Differs from research note: the overview blocks are drawn as plain boxes with a "-> sh. N" sub line, not as doubled boxes.

### p030.jpg - Figure 6.1 "Six connector kinds carry six meanings by dash pattern first and colour second, so a monochrome copy loses nothing." and Figure 6.2 "The same outline carries different meanings in five notations, which is why one drawing holds one notation."
- Domain / type: foundations (chapter 6 visual grammar) / line-kind specimen list; cross-notation shape table.
- Imitate: one sample line per kind with a real label (DATA "H.265 - 6 Mb/s", CONTROL "PTZ preset", SYNC "rsync 02:00", ACCENT "critical uplink", ALERT "on timeout", VERIFY "SHA-256 match"); meaning stated in a few words per kind; printed dash arrays (solid, 1.6 1.0, 0.4 0.8, solid, 3.0 1.2, 2.2 0.8 0.4 0.8); filled head for data, open head for control/sync/verify.
- Rules: GRM-01, GRM-02, GRM-05, GRM-07, M-04. Studio today: yes per kind (the six kinds equal the `kind` enum); partly as one figure, because all six together exceed the engine budgets of 4 line styles (`DATUM-25L`) and 5 colour values (`DATUM-25`) - inferred from the inventory, not run. Family: any. Tokens: kind data, control, sync, accent, alert, verify; shapes box, diamond, stadium, parallelogram, cylinder.
- Cannot express: the printed dash lengths (Studio uses its own dash values); Fig 6.2 itself is a table with shape glyphs, not a diagram kind.

### p033.jpg - Figure 7.1 "The GSP title block carries the ISO 7200 fields plus three separate signatures, a status, a classification and a source reference." and Table 7.1 "Title block fields and who fills them."
- Domain / type: foundations (chapter 7 the sheet) / title block specimen plus field table.
- Imitate: field set and order (owner, title, drawing number, drawn, checked, approved, date, rev, sheet "3 of 12", status, scale "NTS", size, classification, standards with editions, source); small caps field name above mono value; note "Three different people sign; the drafter never approves their own sheet."
- Rules: SHT-01, SHT-03, SHT-04, SHT-07, DOC-05, M-03, M-05, FW-02. Studio today: no.
- Cannot express: title block, sheet frame, signatures. The same facts can travel as document metadata or a separate table block.

### p039.jpg - Figure 8.3 "One identifier names one object for its whole life, from the KAK clause to the label on the installed device and the CMDB record." and Figure 8.4 "The drawing register lists every sheet with discipline, level, status and revision, sorted by number so the series digit groups the set."
- Domain / type: drawing-set framework (chapter 8) / identifier anatomy with leader lines plus a 9-box thread; framed register sheet GEN-001.
- Imitate: the 9-box left-to-right thread (KAK, REQ, register, sheet, BoQ, label on device, test, as-built, CMDB) with one amber box and a KEY row; register columns DWG NO., TITLE, DISC, LVL, STATUS, REV; one amber row for the sheet under discussion; revision history rows that say what changed; frame with zones 1-8 across and A-F down; title strip (owner, title, dwg no., rev, sheet, scale, class).
- Rules: FW-01, FW-02, FW-03, FW-12, SHT-03, SHT-05, DOC-05, PER-04, GRM-09. Studio today: no as a framed sheet (the thread alone is a yes as a flow; the register content can be a `registerTable` block).
- Cannot express: frame, grid zones, title strip, identifier anatomy with leader callouts.

### p492.jpg - Figure 39.1 "Seven gates run in a fixed order, and a failure at any gate returns the work to its source, so the finished file is never patched." and Table 39.1 "Each gate has an owner, a test and a stop condition."
- Domain / type: production (chapter 39 quality gates) / seven-step pipeline with a table beside it.
- Imitate: seven equal boxes left to right with a number tab 01-07 in the corner, name on top and mono sub below; "pass" on every edge; one amber box (G6 Independent check); table columns Gate, Owner, Test, Stop if.
- Rules: DOC-01, DOC-02, DOC-03, PER-04, PER-05, LAY-03, SHT-07, AIM-04. Studio today: yes. Family: flow (direction LR). Tokens: box, tag for the number, sub; edge kind data with label "pass"; class.accent on G6.
- Cannot express: nothing essential; the gate table is a separate table block. Known defect of the manual render: two "pass" labels are clipped (see faults).

### p601.jpg - Appendix D "Diagram spec template and schema", Table D.1 "Spec fields, who fills them, and how they are checked." and the D.1 template JSON
- Domain / type: spec reference, not a figure to reproduce.
- Imitate: field ownership (Planner fills family, id, title, lang, width, apparatus, tiers; Model/drafter fills nodes, edges, boundaries, legend, notes, sources; `labels_verified` is "Checker only" and stays false); title written as a full sentence; `notes[]` used for gaps; `sources[]` with document and clause.
- Rules: MOD-01, MOD-03, MOD-06, MOD-07, DOC-01, DOC-02, AIM-02, AIM-04, SEL-02.
- Studio today: partly (family enum is identical). Template fields Studio v2 does not accept: `id, title, lang, width_mm, apparatus, tiers[], boundaries[]` (Studio: `zones[]` with members), node `desig`, node `accent` as a top-level field (Studio: `class.accent`), `{{key}}` register references.
- Note: only validation rules 1 and 2 of D.2 are on this page; the list continues on the next page, which is not in the pack.

## 2. Reproducible core (14 pages)

### p527.jpg - FIGURE B.3 "Run the questions from the top; the first yes picks the primary diagram family." (GAMBAR 3.1, Indonesian)
- Domain / type: selection (source line prints "illustrates SEL-01") / decision ladder flowchart.
- Imitate: one start box, a spine of nine diamonds going down with "tidak" on the spine, each "ya" going right to a wide result box (capitals family name plus mono catalogue codes); a dashed "BUKAN DIAGRAM" end box; double caption (FIGURE in English, GAMBAR in Indonesian) and SUMBER line with a provenance tag [DITURUNKAN].
- Rules: SEL-01, SEL-05, DOC-01, DOC-02, DOC-03, LAY-03, LAY-05, PER-05. Studio today: yes. Family: flow (direction TB). Tokens: box, diamond, annotation or box for the dashed end; edge kind data, labels "ya"/"tidak".
- Cannot express: nothing essential; at most two nodes per rank, so the TB rank cap is not the problem, but ten ranks make it tall (166 mm or a split). Differs from research note: 20 nodes counted (1 start box, 9 diamonds, 9 result boxes, 1 dashed end box), and no stadium is drawn.

### p538.jpg - FIGURE B.22 "Each zone has its own subnet and VRF, and inter-zone traffic passes only the internal firewall, not the core." (GAMBAR 8.2)
- Domain / type: networks (prints "illustrates NET-04") / L3 logical and security-zone tiers.
- Imitate: band labels at the left in capitals with a mono note under them (WAN / VRF WAN, PERIMETER / titik penegakan, INTI / routing per VRF, ZONA / subnet akhir); node = name, device id, mono address; protocol on every link ("eBGP - /30", "HTTPS 443", "OSPF area 0", "transit per VRF", "SSH"); dashed DMZ frame around one node; amber stacked-outline core as the single accent; KETERANGAN row with two line kinds.
- Rules: DOC-03, GRM-01, GRM-05, GRM-09, PER-03, PER-04, PER-05, MOD-05, LAY-03. Studio today: partly. Family: layered + zones[]. Tokens: box; kind data, control; class.tier, class.accent; sub for addresses.
- Cannot express: tier band label with note, stacked-box (HA pair) shape. Differs from research note: 9 nodes counted (Router WAN, Relai Pembaruan, Firewall Perimeter, Firewall Internal, Core L3, Zona Kamera, Kantor, Server, OOB) and four labelled bands, not five lanes.

### p554.jpg - FIGURE B.39 "The security riser shows paths from field devices to the control room with cable counts per link." (GAMBAR 12.3)
- Domain / type: video and physical security (prints "illustrates VID-06") / five-tier riser.
- Imitate: numbered band labels ("1 - LAPANGAN" ... "5 - RUANG KENDALI") with a mono role note; quantity in every node sub ("16 unit", "4 lemari"); cable type times count on every link ("Cat6 x 16", "FO SM 2 inti x 4", "10G x 2"); three line kinds named in the key row (video and IP data, alarm and control, power feed); one amber node (Switch Inti).
- Rules: DOC-03, GRM-01, GRM-05, GRM-09, PER-04, PER-05, LAY-03, MOD-01. Studio today: yes (partly if the floor bands must be labelled). Family: topology or layered. Tokens: box; kind data, control, sync (dotted power feed in the print), accent.
- Cannot express: numbered band labels. Differs from research note: 13 nodes counted (4 + 3 + 2 + 2 + 2). Reviewer note: the print uses the dotted pattern for "catu daya"; in Studio grammar dotted is `sync`, so the power feed needs its own decision (data with a label is closer to GRM-01).

### p558.jpg - FIGURE B.44 "The container view opens the platform into eight separately running units, each with its technology." (GAMBAR 13.2)
- Domain / type: software (prints "illustrates SW-02") / C4 container view.
- Imitate: tag K1-K8 in the box corner, name, then technology lines in mono; verb plus protocol in brackets on every edge ("memanggil API [HTTPS]", "kueri [gRPC]", "jejak [SQL/TLS]"); dashed frame with label tab "BATAS SISTEM - PLATFORM AI BERDAULAT"; person and external systems outside the frame, marked by sub ("Person", "Eksternal"); three cylinders for stores; one amber container (Layanan RAG).
- Rules: DOC-03, GRM-05, PER-02, PER-03, PER-04, MOD-05, GRM-09, AIM-05. Studio today: yes. Family: layered + zones[]. Tokens: box, cylinder; tag, sub; kind data, control, sync; class.external, class.accent.
- Cannot express: person glyph. 11 nodes, as in the research note.

### p560.jpg - FIGURE B.46 "One RAG query shows the access filter runs in the vector store before any context reaches the model." (GAMBAR 13.4)
- Domain / type: AI platforms (prints "illustrates AI-03") / sequence.
- Imitate: five lifeline heads with name and container tag (K2, K3, K7, K4); messages numbered "01 - ..." to "08 - ..." in mono; solid for calls, dashed for replies, one amber message (03 - cari + filter ACL); key row with three entries; source line names the notation subset ("notasi UML 2.5.1 subset").
- Rules: DOC-03, PER-04, PER-05, GRM-01, GRM-09, M-04, SEL-02. Studio today: yes. Family: sequence. Tokens: lifelines; messages kind data, control (reply), accent.
- Cannot express: activation bars, fragments (none are drawn on this page either).

### p561.jpg - FIGURE B.47 "The threat-model DFD marks DF8 as most exposed, where untrusted documents enter the inference enclave via embedding." (GAMBAR 13.5)
- Domain / type: cyber (prints "illustrates CYB-01") / STRIDE data-flow diagram.
- Imitate: element id in the corner (EE1-3, P1-4, DS1-2) and element type as sub; flow ids in the label ("DF8 embedding"); two dashed boundary frames with tabs "TB1 ENCLAVE INFERENSI", "TB2 KONTEN TAK TEPERCAYA"; shadowed boxes for external entities, a box with a doubled left edge for stores; one amber flow; house-notation sentence in the SUMBER line.
- Rules: DOC-03, DOC-04, PER-03, PER-04, GRM-03, GRM-09, MOD-05, SEL-02. Studio today: partly. Family: graph. Tokens: shadowed (external entity), cylinder (store), box (process); zones[]; kind data, sync, accent.
- Cannot express: store drawn as a double-edged or open-ended box, boundary as a line that cuts flows. 9 elements and 2 boundaries, as in the research note; flow DF5 is not visible on the page (DF1-DF4 and DF6-DF9 are).

### p562.jpg - FIGURE B.48 "The tender review swimlane puts the decision gateway in the Director's lane and uses a link event for the revision loop." (GAMBAR 14.1)
- Domain / type: business process (prints "illustrates BP-02") / BPMN swimlane.
- Imitate: four horizontal lanes with capitals labels (MANAJER PROYEK, TIM TEKNIS, DIREKTUR, POOL PANITIA); short object labels on sequence flows ("matriks", "draf", "ya", "tidak"); a link pair "Ke A" / "Dari A" instead of a long back edge; dashed message flow to the separate pool; key row naming three line kinds; source line stating the BPMN subset and which lanes form which pool.
- Rules: PER-05, DOC-03, M-04, GRM-01, GRM-09, LAY-02, SEL-02. Studio today: partly. Family: swimlane with pools. Tokens: event_start, event_end, event_intermediate, task, gateway_exclusive; kind data, accent, control (dashed message flow).
- Cannot express: message-flow line type, link events, boundary events. 9 nodes, as in the research note. All events are printed as identical plain circles, so the page does not show start/end/link styling.

### p563.jpg - FIGURE B.49 "The ISO 5807 incident triage flowchart keeps the main path in one column and pushes two closure branches aside." (GAMBAR 14.2)
- Domain / type: software/process (prints "illustrates SW-03") / ISO 5807 flowchart.
- Imitate: main path in one column, closure branches to the right; step numbers 01-04 as corner tags on process and I/O steps; what passes between steps on every edge ("ID alarm", "kelas aset", "temuan awal", "berita acara"); dashed branches to the closures; key row (main path, closure branch, escalation decision).
- Rules: PER-05, DOC-03, GRM-02, M-04, LAY-01, LAY-05, GRM-09. Studio today: yes. Family: flow (direction TB). Tokens: stadium, parallelogram, box, diamond; kind data, control, accent.
- Cannot express: nothing essential. Differs from research note: 10 nodes counted (4 terminators, 1 input/output, 3 processes, 2 decisions), and the two closure terminators are drawn almost circular.

### p571.jpg - FIGURE B.58 "One number connects three people, but attribution of each number to its person is unconfirmed." (GAMBAR 15.1); the page also carries FIGURE B.57 "One query calls three store channels, merges once, logs, and returns a three-band answer." (GAMBAR 20.11)
- Domain / type: intelligence (B.58 prints "illustrates INT-01"; B.57 prints "illustrates SW-04") / link chart; second figure is a 4-lifeline, 7-message sequence.
- Imitate (B.58): shape by entity type stated in the SUMBER line (box = person, hexagon = number, parallelogram = account); relation plus source id on each link ("pengguna - S-03", "14 panggilan - CDR-01", "pemilik - OSINT-07"); line style by confidence (solid confirmed with arrow = direction, dashed unconfirmed, dotted tentative); amber outline on the one shared number; provenance tags [TERUKUR], [ASUMSI].
- Rules: DOC-02, DOC-03, DOC-04, MOD-02, PER-04, GRM-07, GRM-09, SEL-02, AIM-07. Studio today: partly. Family: graph (route straight). Tokens: box, hexagon, parallelogram; kind data, control, sync; class.accent.
- Cannot express: a relation and a source badge as separate parts of an edge (one label string only); hexagon and parallelogram keep their ISO 5807 meaning under the one-notation rule (DATUM-35). 7 nodes, as in the research note.

### p547.jpg - FIGURE B.32 "Switch A passes with 30 % margin, while Switch B falls short because two Type 4 PTZs are counted at full PSE allocation." (GAMBAR 10.4)
- Domain / type: power (prints "illustrates PWR-07") / PoE budget tree.
- Imitate: three bands with label and note (SUMBER TERJAMIN, SWITCH POE "anggaran vs alokasi", PERANGKAT "alokasi PSE"); budget and allocation in the node sub ("anggaran 240 W", "alokasi 241,6 W"); watts on every branch; the one failing branch red and dashed, named in the key row; a reference designation in the source node ("=PWR+POS1-TB1"); provenance tags in SUMBER.
- Rules: DOC-01, DOC-03, MOD-01, MOD-02, MOD-04, GRM-01, GRM-06, GRM-09, PER-05, LAY-03. Studio today: yes. Family: layered. Tokens: box; kind data, alert; class.tier; sub.
- Cannot express: band labels with notes. 7 nodes, as in the research note.

### p390.jpg - Figure 32.1 "The federation exchanges ten interfaces with outside parties, and GSP's own support interface IF-10 carries health data only, never evidence."
- Domain / type: DEM programme (sheet GSP-DEM-SYS-100, 1/14) / system context on a framed sheet.
- Imitate: one amber system frame headed "<<system>> DEM FEDERATION" holding six internal blocks in a 2 x 3 grid; ten dashed external blocks around it; a boxed id IF-01..IF-10 next to a two-word content label on each interface; interface table under the figure (IF, BETWEEN, WHAT FLOWS, MEDIUM / CONTROL, SHEET); KEY row with four entries.
- Rules: PER-02, PER-03, PER-04, DOC-03, MOD-05, GRM-01, GRM-09, SHT-03, DOC-05, FW-02, CASE-02. Studio today: partly. Family: layered or graph + one zone. Tokens: box; class.external; edge label "IF-03 working copies"; kind data, control, sync.
- Cannot express: title strip, grid zones, boxed id separate from the label, table inside the figure (use a separate table block). 16 nodes, as in the research note. The top of the page is the tail of the drawing register table.

### p393.jpg - Figure 32.4 "Evidence objects reach the storage zone only through conduit C-03 from the application zone, so no user, edge device or administrator writes to storage directly."
- Domain / type: DEM programme (sheet GSP-DEM-NET-200, 4/14) / zones and conduits.
- Imitate: dashed zone frames with a boxed tab "Z2 POLRES EDGE" ... "Z8 SPPT-TI EXTERNAL"; conduit ids C-01..C-06 as boxed badges on the lines; amber object path ending at the amber Object store; conduit table (ID, ZONES, FLOW, PROTOCOL / CONTROL, PORT, PEP) with the subject row in amber; KEY row (conduit, object path, ledger path, admin).
- Rules: PER-03, PER-04, MOD-05, GRM-01, GRM-09, DOC-03, CASE-02, SHT-03. Studio today: partly. Family: layered or graph + zones[]. Tokens: box; zones with `style:"group"`; kind data, accent, verify, control.
- Cannot express: an empty zone used as a transport band (Z1 WAN holds only rotated text), container-as-node, nested zones, badge separate from label, embedded table. Differs from research note: 12 nodes counted in 7 zones, plus the empty Z1 (8 frames); no nesting is visible.

### p382.jpg - Figure 31.12 "The automatic part of the alarm path uses 5 s of the budget and the operator has 55 s to acknowledge, so REQ-NET-04 is tested on the machine path alone."
- Domain / type: BRD programme (sheet GSP-BRD-OPS-200, 12/15) / swimlane with a time ruler.
- Imitate: six lanes (POST BP05, C2 - PSIM, SHQ OPERATOR, DUTY OFFICER, QRF PATROL, CCC); eight tick labels across the top (t0, +1 s, +3 s, +5 s, +60 s, +5 min, +30 min, close); amber alarm path through Correlate, Cue PTZ, Raise alarm; budget table (SEGMENT, ELEMENTS, BUDGET, CUMUL., TEST) with the subject row in amber; KEY row with three kinds.
- Rules: PER-05, DOC-03, MOD-01, FW-05, FW-09, GRM-01, GRM-09, PER-04. Studio today: partly. Family: swimlane + phases[] as the time columns. Tokens: box or task, diamond or gateway_exclusive; kind data, accent, control.
- Cannot express: a true time axis (max 8 phases, ordinal only), embedded table, sheet frame. 11 nodes, as in the research note.

### p398.jpg - Figure 32.9 "An item can only leave quarantine when two independent copies match H0, and an invalidated item stays readable for audit, so no integrity incident erases its own trail."
- Domain / type: DEM programme (sheet GSP-DEM-SW-210, 9/14) / UML state machine.
- Imitate: stadium states in a serpentine (four across, back along the second row, then down); transitions labelled with ids only (e1..e12), guard table underneath (EVENT, GUARD, ACTION); alert red dashed transitions into Quarantined, verify dash-dot for the return to Sealed; amber on the one state the caption is about (Sealed (WORM)); filled initial dot and two ringed final dots.
- Rules: CASE-02 (key table as last resort), DOC-03, PER-04, GRM-01, GRM-06, M-04, SEL-02. Studio today: partly. Family: flow or graph. Tokens: stadium, circle (initial/final); kind data, alert, verify, accent; annotation for the free note.
- Cannot express: filled initial dot, ringed final state, embedded guard table. 13 states plus 3 pseudo-states, as in the research note.

## 3. Beyond node-link (10 pages)

### p378.jpg - Figure 31.8 "Three sources share one 48 V bus, and the load bus feeds nine breakers whose ratings and loads match the rack schedule on sheet 7."
- Domain / type: BRD programme (sheet GSP-BRD-PWR-220, 8/15) / single-line diagram, IEC 60617.
- Imitate: sources at the top, loads at the bottom; reference designation beside every symbol with rating under it ("-QA1 40 A C - 6 kA"); amber main bus as the subject; nine feeders each ending in tag, watts and breaker amps; quantity table with SOURCE (sheet 9) and MARK columns; KEY row plus the note "IEC 60617 symbols - tags =BP05+SH1-xx".
- Rules: MOD-01, MOD-02, MOD-04, DOC-04, M-03, PER-04, PER-05, GRM-08, SHT-03, FW-05. Studio today: no at full size; a reduced SLD is partly. Family: sld. Tokens: bus, box with symbol `iec:breaker` and similar; kind data, accent.
- Cannot express: more than 24 nodes, symbols as the node outline, embedded table. Differs from research note: three bars are drawn (AC 230 V bar, amber DC MAIN BUS 48 V, LOAD BUS), not two. The symbol count could not be confirmed exactly at this resolution.

### p433.jpg - Figure 34.6 "The CDU moves 49.0 kW from cold plates to facility water at 73.9 L/min, and Jakarta's 28 C wet bulb makes the trim chiller CH-T1 necessary."
- Domain / type: AIF programme (sheet GSP-AIF-MEC-230, 6/14) / liquid-cooling P&ID in ISA-5.1 style.
- Imitate: two loops told apart by colour and pattern (amber TCS, ink FWS, dashed return) and named in the KEY row; instrument bubbles TT, FT, LT with loop numbers; dashed package boundary "CDU-01 - 100 kW - N+1 pumps"; derivation table (QUANTITY, BASIS, VALUE, PROV.) with the governing row in amber; the arithmetic repeated as mono lines under the sheet.
- Rules: MOD-01, MOD-02, DOC-04, GRM-07, GRM-09, PER-03, SHT-03. Studio today: no.
- Cannot express: pipe line classes, valve and exchanger symbols, bubbles as node outlines (isa: exists only as a badge), embedded table. Bubble loop numbers are barely legible at this resolution.

### p541.jpg - FIGURE B.26 "Rack AJ05 holds four GPU servers low and dual leaves high, with 21.4 kW design load and 360 kg." (GAMBAR 9.1)
- Domain / type: data centre (prints "illustrates DC-03") / rack elevation.
- Imitate: heavy units low, network high; inside each tall unit the name plus "4U - 8 GPU - 4,8 kW - 70 kg"; thin units labelled by leader to the right with a mono spec; U ruler at the left; totals stated in the caption; SUMBER line stating the numbering convention (U from the bottom, EIA/ECA-310).
- Rules: DOC-01, DOC-02, MOD-02, SHT-04, PER-05, LAY-03. Studio today: partly. Family: rack. Tokens: box with `u` height and class.row order; sub for the spec.
- Cannot express: U numbers, leader callouts, totals table. Differs from research note: the ruler is labelled every fifth unit (1U, 6U ... 41U), the blanking panel is plain (no hatch), and no totals table is on this page.

### p410.jpg - Figure 33.3 "Three rows of six positions sit between 5.2 and 9.2 m from the wall, and the front-row centre sees the full wall within the 70 degree criterion."
- Domain / type: C2R programme (sheet GSP-C2R-ARC-310, 3/15, scale 1:150) / general arrangement plan.
- Imitate (as a brief for another tool): scale bar plus ratio, north arrow, overall dimension, amber sight cone as the one subject, hatches named in the KEY row (riser +0.30, riser +0.60, service void), row table and the angle arithmetic under the sheet.
- Rules: SHT-03, SHT-04, PER-04, GRM-08, GRM-09, MOD-02, LAY-05 (exception for plans). Studio today: no.
- Cannot express: to-scale geometry, dimensions, scale bar, north arrow.

### p552.jpg - FIGURE B.37 "Perimeter cameras are paired facing each other to close foot-of-mast blind zones, and gate lane OR-01 is fully covered at Characterise." (GAMBAR 12.1)
- Domain / type: video surveillance (prints "illustrates VID-03") / camera coverage plan.
- Imitate (as a brief): five density classes with px/m ranges in a KERAPATAN row, a separate SIMBOL row, scale bar with "skala 1:1075 pada lebar cetak 166 mm", north arrow, amber frame on the operational requirement OR-01, note that symbols are a house legend and not a standard.
- Rules: SHT-04, DOC-04, GRM-03, GRM-07, GRM-09, PER-04. Studio today: no.
- Cannot express: geometry, hatched coverage polygons, scale. Reviewer note: five hatch classes are printed while GRM-08 allows three patterns per figure.

### p575.jpg - FIGURE B.65 "Three observation posts lie 0.9 to 2.8 km from the command post, all in UTM zone 49S." (GAMBAR 16.2); the page also carries FIGURE B.64 "A GSP map sheet carries twelve elements, each answering one reader question." (GAMBAR 16.1)
- Domain / type: geospatial (B.64 prints "illustrates GEO-01", B.65 prints "illustrates GEO-02") / map anatomy with callouts; location map with UTM grid.
- Imitate (as a brief): grid labels on both axes (464-469 E, 9285-9289 N), scale bar plus ratio at a stated print width, grid-north arrow with the convergence note, legend list, locator inset, reference-system block (datum, zone, EPSG, accuracy class), coordinate register table for the four points.
- Rules: SHT-04, DOC-02, MOD-02, M-03, AIM-07, GRM-09. Studio today: no.
- Cannot express: maps with a coordinate grid, scale bar, north arrow, inset. The coordinate register can be a separate table block.

### p373.jpg - Figure 31.3 "With H01 cut, ring W carries all six posts over H08 at 63 Mb/s, which uses 35 % of a 182 Mb/s hop, so one link failure costs no video."
- Domain / type: BRD programme (sheet GSP-BRD-NET-200, 3/15) / WAN topology with two microwave rings.
- Imitate: two ring rows titled "RING W - ERPS instance 1 - R-APS VLAN 4091" and "RING E ..."; hop id and km above each segment, post id and host number below each node; boxed "RPL owner - blocked" badges on the closing hops; amber worst hop with an amber three-line worst-case note; two hop tables (HOP, ENDS, km, GHz, DISH, MODE - Mb/s); capacity arithmetic under the sheet.
- Rules: DOC-03, MOD-01, FW-07, PER-04, GRM-01, GRM-09, LAY-03, SHT-03. Studio today: partly. Family: graph with class.col/row for the two rings. Tokens: box or circle; kind data, accent, sync (VSAT backup).
- Cannot express: radio symbol as the node outline, embedded hop tables, sheet frame. 18 nodes, as in the research note.

### p468.jpg - Figure 36.8 "Detection covers 82 of 133 priority techniques (62 %), below the 70 % target, and Defense Impairment is the weakest tactic that matters most, because tampering there blinds every other column."
- Domain / type: SOC programme (sheet GSP-SOC-DET-510, 8/11) / coverage heat matrix (15 tactics x 6 telemetry layers) with a bar per row.
- Imitate: each cell encodes the level twice (hatch density and a digit 0-3); a fraction per row ("2/9") and a bar with a target tick; red only for rows under 35 %; the subject row label in amber; a "READING THE MATRIX" note block and a KEY row; total row "82/133 = 62 % - target 70 %".
- Rules: SEL-04, GRM-07, GRM-08, PER-07, PER-04, GRM-06, GRM-09. Studio today: partly, as a chart and not a diagram: H-03 heatmap or P-15 table chart.
- Cannot express: hatch plus digit double encoding, bars attached to matrix rows (a composite chart may place panels side by side).

### p470.jpg - Figure 36.10 "The October page shows six KPIs as bullet charts with target and bands, so the one breach, P1 containment at 5.2 h against 4 h, is visible at once and in red only there."
- Domain / type: SOC programme (sheet GSP-SOC-OPS-530, 10/11) / KPI report page layout.
- Imitate: page opens with a one-sentence result; each KPI = name, target, actual in mono, a bar for the actual, a tick for the target, three hatched bands; red on the single breach only; panel B shows the rejected tile design with the reason beside it; KPI definition table (KPI, DEFINITION, SOURCE, TARGET).
- Rules: SEL-05, PER-04, PER-07, GRM-06, GRM-07, GRM-08, MOD-02. Studio today: partly: chart P-09 bullet (composite for six panels).
- Cannot express: the page mock-up and the defect tiles.

### p486.jpg - Figure 37.11 "Every requirement maps to at least one sheet and exactly one acceptance test, and the provenance rule REQ-OSI-06 is carried by three sheets and proved by one software test."
- Domain / type: OSI programme (sheet GSP-OSI-QA-800, 11/11) / requirement-to-sheet trace matrix.
- Imitate: 12 requirement rows x 11 sheet columns, a filled dot where a sheet satisfies a requirement and a faint dot elsewhere; TEST and PASS CRITERION columns to the right; a count row under the columns as a set check; the subject row (REQ-OSI-06) in amber; test stages table (STAGE, WHERE, EVIDENCE). The same page prints Table 37.4, an interface matrix done as a plain table.
- Rules: FW-09, SEL-04, MOD-04, PER-04, GRM-09. Studio today: partly, as a table block or P-15 table chart.
- Cannot express: dot matrix as a diagram kind.

## Faults visible in these reference pages

These break the manual's own rules; do not copy them.
- p028: in Fig 5.4 the cylinder rim runs through the label "Store"; the note "off-sheet connector: sheet/zone" is struck through by a connector.
- p030: Fig 6.2 last row (connector / event / initial-final) has no shape drawn; the red note "One diamond, four meanings ... (rule SM-04)" overlaps the bottom table rule, cites a rule id outside the manual's own index, and says four meanings where the caption says five notations.
- p039: title strip classification RAHASIA inside a page marked BIASA (teaching example, but it contradicts DOC-05/SHT-06 if copied).
- p492: "pass" is clipped to "ss" on G2 -> G3 and G5 -> G6; sub lines end in an ellipsis in G6 ("+ 5 s...") and G7 ("block +..."); a stray red arrowhead under G2 and a tick under G6 are left from return paths that are not drawn, although the caption is about returns.
- p527: none seen beyond very small mono type in the result boxes.
- p538: the label "KANTOR" sits on a connector; "transit per VRF" is overlined by a connector; three zone links share a very small landing area on the core.
- p554: "FO SM 2 inti x 4" is crossed by its own connector; "Cat6 x 16" and "koaksial x 16" touch lines.
- p558: tags K6, K7, K8 are crossed by the cylinder rims; "verifikasi [LDAPS]" sits on the boundary frame line; the entry connector runs along the frame's label tab.
- p560, p571 (B.57): a lifeline passes through message labels ("05 - prompt + konteks", "06 - draf jawaban"; "06 - baris log (--log-queries)").
- p561: tags DS1 and DS2 are crossed by the doubled store edge; "DF9 bobot" is struck by its dotted line; the DF1 connector runs along the TB1 frame top; the TB1 frame touches the Admin box. The diagonal un-hopped DFD connectors reported in the research notes are not on this page: its routing is orthogonal.
- p562: labels "KAK", "A" and "ok" are squeezed onto connectors only a few millimetres long; the amber "tidak" branch is a stub; start, end and link events are indistinguishable.
- p563: "ya" is printed between two parallel stubs under each decision; type inside the nodes looks below the 5.5 pt floor at print size (not measurable from the image).
- p571 (B.58): "pengguna - S-05" is struck by its dashed line.
- p390, p393: boxed badges crowd each other and the zone tabs (C-02, C-04, C-06 beside "Z4 POLDA APPLICATION"); rotated text in the Z1 frame on p393; several labels in p390 sit close enough to lines that overprint cannot be ruled out at this resolution.
- p382: "ONVIF event" is struck through by its connector; "no" is partly covered by the Close FA box edge; "<= 10 s - MPLS" floats away from its line; three nodes carry amber (PER-04 allows one accented element plus its edges).
- p398: "e5" is overprinted by the red dashed transition, which also crosses another transition without a hop; "e9" labels two transitions.
- p373: two nodes and one link are amber; the VSAT leader text touches its leader line.
- p378, p433: very small type next to symbols ("-FA2 T1+2", "LD-01", bubble numbers).
- p410: row position labels are threaded on a line; "SERVICE VOID 1.0 m - rear access to wall" runs through the hatch and outline.
- p552: the amber OR-01 label and both "zona buta 0-19 m" labels sit on the fence line and hatching; five hatch classes exceed GRM-08.
- p468, p470: the KEY entry for red ("< 35 % covered", "breach") shows a dashed red line while the mark in the figure is a solid red bar; on p468 the hatch behind the digits lowers legibility.
- p486: none seen; sheet zone F is empty space.
- p033, p541, p547, p575, p601: no fault seen.

Pages opened for this index (30): p028, p030, p033, p039, p373, p378, p382, p390, p393, p398, p410, p433, p468, p470, p486, p492, p527, p538, p541, p547, p552, p554, p558, p560, p561, p562, p563, p571, p575, p601.
