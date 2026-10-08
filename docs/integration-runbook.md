# Runbook tích hợp — đưa thay đổi trên `arena/44b4109e-tat-qpn` vào branch build

Tài liệu này dành cho người thực hiện tích hợp trên máy Windows của build machine. Mọi con số và
kết luận bên dưới đã được **chạy thật trong sandbox Linux** (phần "Đã kiểm chứng"), trừ những mục
được ghi rõ là chỉ kiểm tra tĩnh hoặc chỉ kiểm tra được trên Windows.

## 1. Hiện trạng nhánh (tính đến commit `a1b36c1`)

```
bbcdc39  Initial commit
993669d  File data test                         ← mang theo xlsx + zip + html vào main
   ...
7f26492  arena/36b4835b-tat-qpn  (BRANCH BUILD)  ← "Make \"Tên lỗi\" a manually entered field…"
e77d83f  main = merge(PR #5 từ arena/36b4835b)
d5a2ca4  Records UI: manual condition, natural sort, cột kéo giãn
6cda516  LAN update path + Settings + Publisher (UNC)
b5185c3  MQIS → mgmtNo trong Drawer
854b1bc  Khoá mgmtNo ở tầng service/API
a1b36c1  Sửa script publish Windows + runbook Windows   ← HEAD của arena/44b4109e-tat-qpn
```

Điểm quan trọng nhất: **tip của branch build (`7f26492`) là tổ tiên trực tiếp của HEAD** — branch
build không chứa commit nào mà branch này thiếu (đã kiểm tra bằng `git merge-base --is-ancestor`).
Vì vậy không có khả năng "đè mất chức năng đã có"; vấn đề duy nhất là **chọn cách chuyển bao nhiêu
commit và kèm theo những file nào**.

## 2. Nội dung cần tích hợp, theo từng mảng

| Mảng | File chính | Hành vi thay đổi |
|---|---|---|
| **MQIS** | `src/business/records/recordsTable.ts`, `src/components/RecordDetailDrawer.tsx`, `src/i18n/index.ts` | Cột MQIS và ô "Management Number (MQIS)" đọc **cùng một field** `mgmtNo` qua `canonicalCodeText`; input `mqisCode` độc lập bị bỏ khỏi form (dữ liệu `mqisCode` vẫn còn, vẫn import/search/export được) |
| **Khoá `mgmtNo`** | `src/models/defect-record.ts`, `server/http/app.ts`, `src/services/records/recordService.ts` | `assertManagementNumberUnchanged` chặn đổi số quản lý của bản ghi đã tồn tại ở **cả HTTP PATCH và service IndexedDB**; giá trị gửi kèm mà không đổi thì được chấp nhận và bị gỡ khỏi patch; đổi thật → 400 `validation-failed` + `field: mgmtNo` |
| **Records UI** | `columnWidths.ts`, `ColumnResizeHandle.tsx`, `ColumnsMenu.tsx`, `RecordsWorkspace.tsx`, `columnWidthPreferences.ts` | cột kéo giãn được (lưu theo máy, có version, chống dữ liệu hỏng), cột "Tình trạng thủ công", sắp xếp tự nhiên (`naturalCompare`) |
| **UNC path** | `src/utils/uncPath.ts`, `desktop/update/source.ts`, `tests` | một định nghĩa duy nhất cho chuẩn hoá/kiểm tra đường dẫn mạng: `\\`/`/` gộp separator, từ chối ổ đĩa, `\\?\`, `.`/`..`, ký tự điều khiển, >260 ký tự; **giữ nguyên chữ hoa/thường** |
| **Settings** | `desktop/main/settings.ts`, `desktop/main/bridge.ts`, `src/components/DesktopPanel.tsx` | `updateSource` / `updateChannel` / `updateChecksEnabled` trong `data\desktop-settings.json`; nút **Check update folder** với 5 trạng thái (`not-configured`, `unreachable`, `not-readable`, `no-manifest`, `invalid-manifest`); không chạy khi mở panel để không treo vì SMB timeout |
| **LAN Publisher** | `desktop/update/publish.ts`, `transfer.ts`, `archive.ts`, `layout.ts`, `BUILD_AND_PUBLISH_TNP_TEST.bat` | thứ tự publish bất biến với `version.json` **cuối cùng**; probe ghi-đọc-xoá để thử quyền ghi thật; chặn lệch kênh; tự tăng `tnpBuild` và ghi lại vào `package.json`; **từ lần này: `publish.js` từ chối mọi argument rời rạc, là dấu vết của một path có dấu cách bị cắt đôi** |
| **Script Windows** | 2 file `.bat`, `.gitattributes` | mỗi lần hỏng phải dừng thật sự (`exit /b 1` ở thân script); pre-flight viết trực tiếp thay vì truyền qua `:step`; `.bat` giao về Windows bằng CRLF |

## 3. Cách tích hợp ĐÃ ĐƯỢC CHỌN: cherry-pick (không FF-merge)

Lý do: `main` (`e77d83f`) đang mang ba file ở thư mục gốc mà branch build **không** có:

```
EXCEL_EXPORT_FILE_20261002181424.xlsx   33 KB   ← workbook THẬT của công ty
TNP_Defect_Management_Source.zip       375 KB   ← bản đóng gói nguồn
Theo dõi TAT  hệ thống TNP.html        1.2 MB   ← tài liệu tham chiếu legacy (docs/legacy-analysis.md citing nó)
```

Nếu merge thường (hoặc FF) branch của tôi vào branch build thì cả ba file đi theo, vì chúng nằm
giữa `7f26492` và HEAD. Cherry-pick đúng 5 commit của tôi thì không mang chúng.

**Đã chạy thử trong sandbox** trên một bản clone tạm từ `7f26492`:

```
$ git cherry-pick e77d83f..a1b36c1          # 5 commit
→ không conflict, không file nào bị giữ lại
$ git diff --stat HEAD a1b36c1               # tree thử nghiệm vs tree branch của tôi
 EXCEL_EXPORT_FILE_20261002181424.xlsx   | Bin 0 -> 33968 bytes
 TNP_Defect_Management_Source.zip        | Bin 0 -> 375306 bytes
 Theo dõi TAT  hệ thống TNP.html         | 9378 ++++++++++
 3 files changed
```

nghĩa là **chênh lệch duy nhất là đúng 3 file kia** — không thiếu một dòng code, test hay tài liệu
nào. Và bộ test trên cây *không có* 3 file đó:

```
Test Files  52 passed | 1 skipped (53)
Tests       680 passed | 2 skipped (682)
tsc --noEmit  → clean
vite build    → ok
tests/update + tests/portable → 210 passed
```

2 test nhảy qua là `src/services/import/tnpFileParser.test.ts` và
`realWorkbook.integration.test.ts`; cả hai dùng `existsSync(workbook) ? it : it.skip` đúng theo quy
ước "workbook là dữ liệu công ty, bị gitignore, không có trong checkout sạch" — ghi ngay trong comment
của test. **Đây cũng là lý do `.gitignore` ghi "Never commit the real company workbook"**: việc
`993669d` commit file xlsx trái với quy ước đó, chứ không phải test cần nó. Nếu về sau muốn khôi phục
2 test đó trên branch build thì đặt file xlsx vào thư mục gốc machine (không commit) là đủ.

### Lệnh thực hiện (trên build machine)

```bat
cd /d D:\TAT TNP\TAT_QPN-main
git fetch origin
git switch -c integration\tat-qpn-2026-10-08 origin/arena/36b4835b-tat-qpn
git cherry-pick 854b1bc~4..a1b36c1
```

`git cherry-pick` với dãy `A~4..B` áp đúng 5 commit theo thứ tự (`d5a2ca4`, `6cda516`, `b5185c3`,
`854b1bc`, `a1b36c1`). Nếu một commit nào đó dừng vì conflict: **dừng lại, đừng tự merge** —
xử lý thủ công rồi `git cherry-pick --continue`, hoặc hủy bằng `git cherry-pick --abort` (không để
lại thay đổi bán phần).

Kiểm tra sau khi cherry-pick, trước khi push:

```bat
npm ci
npm run typecheck
npm test
npm run test:server
npm run test:portable
npm run test:portable-runtime
npm run test:update
git ls-files --eol BUILD_AND_PUBLISH_TNP_TEST.bat
```

`git ls-files --eol` phải in `i/lf w/crlf attr/text eol=crlf` (blob LF, working tree CRLF).
Nếu `w/lf` thì `.gitattributes` chưa kịp áp dụng với file có sẵn — chạy
`git rm --cached -q .gitattributes && git checkout -- .` hoặc re-clone.

Rồi chạy thật toàn bộ checklist Windows trong `docs/windows-test-checklist.md` **trên branch build
đã tích hợp**, vì đó mới là branch mà `BUILD_AND_PUBLISH_TNP_TEST.bat` yêu cầu
(`EXPECTED_BRANCH=arena/36b4835b-tat-qpn`).

### Cách hoàn tác nếu cần

```bat
git cherry-pick --abort                       :: nếu đang giữa chừng
git reset --hard origin/arena/36b4835b-tat-qpn :: nếu đã commit local mà chưa push
```

Không force-push branch build. Không xoá `data\`, `backups\`, `reports\` — chúng là dữ liệu production
của máy Owner và không bao giờ là một phần của commit nào.

## 4. Sau khi tích hợp: publish TEST rồi mới nói "đã chạy trên Windows"

Thứ tự bắt buộc (mỗi bước có kỳ vọng cụ thể trong `docs/windows-test-checklist.md`):

1. Build TEST Portable trên branch build → §2.
2. Kiểm tra thư mục LAN từ cả hai phía: **Check update folder** trong app và `publish.js --check-only`
   → §3.
3. Publish TEST bằng `BUILD_AND_PUBLISH_TNP_TEST.bat "\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates"`
   (có dấu nháy) → §4.
4. Kiểm `version.json`: `channel` = `test`, `product`/`architecture` khớp, `package` là một tên file
   trần, `size` và `sha256` khớp `Get-FileHash`/`certutil`, không còn `.tmp` → §5.
5. Update từ máy Owner: dialog → COPYING có phần trăm thật → COMPLETE; bản ghi đã đối chiếu vẫn còn;
   `backups\`/`reports\` không đổi số file; `.tnp-update\runtime-backup\` có runtime cũ → §6.
6. Chuỗi drill từ chối 7a–7k → §7, đặc biệt **7a** (path không để trong nháy phải bị từ chối) và
   **7k** (gate hỏng phải dừng trước khi publish).

## 5. Đã kiểm chứng trong sandbox — và chưa kiểm chứng gì

**Đã chạy thật ở đây:** toàn bộ 5 suite (`682` test), typecheck 3 dự án, `vite build`,
`build:desktop`, `npm audit` (0 high), `git diff --check` sạch; cây cherry-pick thử nghiệm
(không 3 file artifacts) cũng xanh; `eol=crlf` giao đúng CRLF lúc checkout; hành vi publisher
(thứ tự bước, manifest cuối, probe quyền ghi, lệch kênh, tăng build number) chạy trên file thật.

**Chỉ kiểm tra tĩnh / chỉ Windows:** mọi dòng trong hai file `.bat` — chúng tôi đã đọc và khẳng định
bằng test trên **văn bản file**, nhưng `cmd.exe` không tồn tại trong môi trường này, nên *chưa ai
chạy* `BUILD_AND_PUBLISH_TNP_TEST.bat` hay `UPDATE_AND_BUILD_TNP.bat`; ba lỗi đã sửa (gate không dừng,
pre-flight bị cắt qua `:step`, LF-only) đều nằm trong nhóm đó. Tương tự: `Compress-Archive`/
`Expand-Archive` thật, `ELECTRON_RUN_AS_NODE=1` của helper, khoá file NTFS khi swap runtime,
SMB timeout, quyền share, và một lần cập nhật end-to-end trên máy Owner. Không báo cáo nào được phép
nói "BAT đã chạy thành công" cho tới khi mục §4–§7 xong trên máy Windows.
