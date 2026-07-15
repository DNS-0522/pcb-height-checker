# analysis/ — DXF×STP 探勘腳本（一次性）

## 2026-07-12 更新：H 值 OCR 管線（視覺辨識版）已跑通
真實 DXF 雖無 TEXT 實體，但 H= 標註是「短線段描邊字」，可幾何聚類出精確位置，
再渲染小圖由視覺模型讀值 → flood-fill 關聯包圍區域。結果：

| 檔 | 內容 |
|---|---|
| `hlabel_cluster.py` | 短線段聚類找 H= 標註候選（第一輪 MAX_SEG=4/GAP=1.2）|
| `hlabel_crops_fast.py` | 視圖整張 rasterize 一次 + numpy 裁切 + contact sheet（讀值用）|
| `text_cluster.py` | `*_DXF_TEXT` 圖層 POLYLINE 字元聚類（視圖標題）|
| `glyph_match.py` | **A 方法:離線向量字形比對**(零 OCR/零網路)。`build`=從已確認標註建 10 字元模板;`evaluate`=148 標註驗證:**自動接受 123(83%)全對、25 旗標人工、0 安靜錯誤**。Chamfer 距離+16 方位+多重過濾自選+模糊度/截斷防護 |
| `zone_extract.py` | 14px/mm rasterize → connected-components → 分層採樣關聯標註→區域 → `zones.json` |
| `hlabel_values.json` | **150 個 H 標註**（view/座標/值），TOP{0,.5,.6,.7,.75,.85,1,1.2} BOT{0,.5,.8,1,1.2,2,2.5,3} |
| `zones.json` | 149/150 關聯成功，137 區，**5 區有多值衝突**（標註跨界線/一矩形兩標註）已旗標 |
| `renders/zones_*.png` | 分區上色 QA 疊圖（git-ignored，重跑 `py zone_extract.py` 產生）|

教訓：聚類勿靜默丟棄超大群（密集標註會鏈接成大群，要遞迴細分）；大字體筆畫
超過 MAX_SEG 上限會漏；標註可能成對出現在同一矩形內（H=0+H=0.7）需人工判讀。

---

2026-06-30 用真實樣本做的探勘與交叉驗證腳本。**這些是研究用一次性腳本，不是產品程式**；正式的 STP 解析在 `../server/src/step-parse.ts`。從 Power-budget-calculator 的暫存區搬來歸位。

## 輸入樣本
- DXF：`F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf`（Creo 匯出，A0）
- STP：`F:\ux3607ya.10-3d_0616\0616_1839_top_and_bottom.stp`（Allegro 17.2，PCB Design）

## 依賴
`py -m pip install -r requirements.txt`（Python 3.12;或在 repo 根目錄 `npm run setup:py`）

## DXF 腳本
| 檔 | 用途 |
|---|---|
| `explore.py` / `explore2.py` | 圖層、實體統計、範圍、block、DIMENSION 內容 |
| `segment.py` / `segment2.py` / `segment3.py` | 用幾何點密度/投影自動切出 8 個板視圖的網格 |
| `render.py` | 單張裁切渲染（ezdxf+matplotlib，白底黑線）`render.py out.png 寬 x0 y0 x1 y1` |
| `render_batch.py` + `jobs*.txt` | 一次載入、批次渲染多個裁切（第 7 欄=1 可水平翻轉）|

## STP 腳本（OCP/OpenCASCADE，一次性交叉驗證）
| 檔 | 用途 |
|---|---|
| `stp_extract.py` | XCAF 遞迴解算變換 → 每顆元件全域包圍框 → `stp_components.csv` |
| `stp_bbox.py` | 原始 CARTESIAN_POINT 範圍/單位（mm）快檢 |
| `stp_analyze.py` / `stp_scatter.py` / `stp_shapes.py` | XY 分群、散佈/footprint 圖（發現 3 個 Y 區帶）|
| `stp_tree.py` | 組裝樹（root=BOARD_OUTLINE + COMPONENTS）|
| `stp_debug.py` | 逐元件原型幾何除錯（找出 3.81mm 佔位）|
| `stp_heights.py` | 元件高度分佈、依封裝統計（量化 995 顆佔位）|

## 關鍵發現（詳見 memory: pcb-height-checker-project）
1. **真實 DXF 無文字層**：0 個 TEXT/MTEXT，H= 全被打散成線段 → 既定「H 文字→包覆多邊形」演算法失效。需 Creo 重匯出含 TEXT、或 OCR、或手動數位化。
2. **DXF 版面**：A0，4 類別(CONN/Limit/PAD/WHITE)×左 TOP・右 BOTTOM(鏡像)。H 值只在 Limit。
   - TOP Limit H = {0, 0.6, 0.75, 0.85, 1, 1.2}；BOT Limit H = {0, 0.5, 0.8, 1, 1.2, 2, 2.5, 3}
   - 孔徑(PAD)是可機器讀取的 82 個 DIMENSION（`%%c`=⌀）
3. **STP**：板頂 Z=0、板底 Z=−0.78；頂面件高=z1、底面件凸出=−0.78−z0。**995/3925 顆 = 3.81mm 佔位**（CTK0_SM*）。元件散佈 3 個 Y 區帶，需和 step-parse.ts 對照後只取主機板群。

## 重新產生渲染圖
渲染圖（`renders/*.png`）與 `stp_components.csv` 已被 .gitignore 排除（可重新產生）：
```
py stp_extract.py            # 產生 stp_components.csv
py render_batch.py jobs2.txt # 依 jobs 檔批次渲染
```
