# analysis/ — DXF×STP 探勘腳本（一次性）

2026-06-30 用真實樣本做的探勘與交叉驗證腳本。**這些是研究用一次性腳本，不是產品程式**；正式的 STP 解析在 `../server/src/step-parse.ts`。從 Power-budget-calculator 的暫存區搬來歸位。

## 輸入樣本
- DXF：`F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf`（Creo 匯出，A0）
- STP：`F:\ux3607ya.10-3d_0616\0616_1839_top_and_bottom.stp`（Allegro 17.2，PCB Design）

## 依賴
`py -m pip install ezdxf matplotlib numpy cadquery-ocp`（Python 3.12）

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
