# Runbook tích hợp — đưa công việc trên `arena/44b4109e-tat-qpn` vào branch build

Tài liệu này cho người thực hiện tích hợp. Lệnh copy-paste đầy đủ, có "Kỳ vọng" từng bước, nằm ở
**`docs/integration-powershell.md`**; tài liệu này giải thích *vì sao* làm như vậy và cái gì đã được
đo. Mọi số liệu ghi ở đây là kết quả chạy thật trong sandbox Linux, trừ chỗ nói rõ là chỉ kiểm tra tĩnh
hoặc chỉ kiểm tra được trên Windows.

PR **#6 giữ nguyên draft** theo quyết định của owner, chỉ dùng để đối chiếu nội dung. Tích hợp thật làm
bằng **cherry-pick**, không merge, và không auto-merge ở bất kỳ đâu.

## 1. Hiện trạng nhánh

```
bbcdc39  Initial commit
993669d  File data test                        ← mang xlsx + zip + html vào main
   ...
7f26492  arena/36b4835b-tat-qpn (BRANCH BUILD) — "Make \"Tên lỗi\" a manually entered field…"
e77d83f  main = merge(PR #5 từ arena/36b4835b)  ← điểm phân nhánh của branch tôi
d5a2ca4  Records UI: cột "Tình trạng thủ công", sắp xếp tự nhiên, kéo giãn cột
6cda516  LAN update path + Settings + Publisher (UNC)
b5185c3  MQIS → mgmtNo trong Drawer
854b1bc  Khoá mgmtNo ở tầng service/API
a1b36c1  Sửa 3 lỗi script publish Windows + checklist Windows
<mới>    Sửa tên folder portable + runbook này + hướng dẫn PowerShell   ← HEAD
```

Nền tảng của toàn bộ kế hoạch: **tip branch build (`7f26492`) là tổ tiên trực tiếp của HEAD**
(`git merge-base --is-ancestor` → OK). Branch build không có commit nào mà branch này thiếu, nên không có
chuyện "đè mất chức năng đã có"; câu hỏi duy nhất là *chuyển bằng cách nào* và *file nào đi kèm*.

**Không gõ tay danh sách SHA.** Dùng dải, và in ra trước khi làm:

```powershell
git rev-list --reverse --oneline e77d83f..origin/arena/44b4109e-tat-qpn
git rev-list --count e77d83f..origin/arena/44b4109e-tat-qpn
```

`e77d83f` là merge commit của `main`, tức điểm phân nhánh, nên dải bao trọn công việc của branch này và
chỉ nó — kể cả các commit gửi thêm sau này. Đối chiếu danh sách in ra với bảng §2: đủ mọi chủ đề, không
có gì lạ.

## 2. Nội dung cần tích hợp, theo từng mảng

| Mảng | File chính | Hành vi thay đổi |
|---|---|---|
| **MQIS** | `src/business/records/recordsTable.ts`, `src/components/RecordDetailDrawer.tsx`, `src/i18n/index.ts` | Cột MQIS trong bảng và ô "Management Number (MQIS)" trong Drawer đọc **cùng một field** `mgmtNo` qua `canonicalCodeText`. Input `mqisCode` độc lập bị bỏ khỏi form; dữ liệu `mqisCode` vẫn còn, vẫn import/search/export được. |
| **Khoá `mgmtNo`** | `src/models/defect-record.ts`, `server/http/app.ts`, `src/services/records/recordService.ts` | `assertManagementNumberUnchanged` chặn đổi số quản lý của bản ghi đã tạo ở **cả** `PATCH /api/records/:id` **và** service IndexedDB. Gửi kèm giá trị không đổi → vẫn 200 và `mgmtNo` bị gỡ khỏi patch; đổi thật → 400 `validation-failed` + `field: mgmtNo`. Create + import giữ nguyên; fingerprint, whitelist `status`/`dueDate`, schema SQLite, dữ liệu đã lưu không đụng tới. |
| **Records UI** | `columnWidths.ts`, `ColumnResizeHandle.tsx`, `ColumnsMenu.tsx`, `RecordsWorkspace.tsx`, `columnWidthPreferences.ts` | Kéo giãn cột (lưu theo máy, có version, tự fallback nếu dữ liệu hỏng), cột "Tình trạng thủ công", so sánh tự nhiên (`naturalCompare`). |
| **UNC path** | `src/utils/uncPath.ts`, `desktop/update/source.ts` | một định nghĩa chuẩn hoá/kiểm tra đường dẫn mạng dùng chung cho desktop và test: gộp separator, từ chối ổ đĩa, `\\?\`, `.`/`..`, ký tự điều khiển, >260 ký tự; **giữ nguyên hoa/thường**. |
| **Settings** | `desktop/main/settings.ts`, `desktop/main/bridge.ts`, `src/components/DesktopPanel.tsx` | `updateSource` / `updateChannel` / `updateChecksEnabled` trong `data\desktop-settings.json`; nút **Check update folder** với 5 trạng thái; không chạy kiểm tra lúc mở panel để không treo vì SMB timeout. |
| **LAN Publisher** | `desktop/update/publish.ts`, `transfer.ts`, `archive.ts`, `layout.ts` | thứ tự bước bất biến với `version.json` **cuối cùng**; probe ghi-đọc-xoá để dò quyền ghi thật; chặn lệch kênh; tự tăng `tnpBuild` và ghi lại `package.json`; từ chối token rời (path có dấu cách bị cắt đôi). |
| **Script Windows** | 2 file `.bat`, `.gitattributes`, `scripts/package-portable.mjs` | mọi điểm hỏng phải dừng thật sự; pre-flight viết trực tiếp; `.bat` giao về Windows bằng CRLF; `PORTABLE_DIR` khớp folder packager tạo ra, override bằng `TNP_PORTABLE_DIR` (xem §4b). |

## 3. Vì sao cherry-pick chứ không merge

`main` (`e77d83f`) đang mang ba file ở thư mục gốc mà branch build **không** có:

```
EXCEL_EXPORT_FILE_20261002181424.xlsx   33 KB   ← workbook THẬT của công ty
TNP_Defect_Management_Source.zip       375 KB   ← bản đóng gói nguồn
Theo dõi TAT  hệ thống TNP.html        1.2 MB    ← tài liệu tham chiếu legacy
```

Merge (hay fast-forward) branch của tôi vào branch build sẽ kéo cả ba theo, vì chúng nằm giữa `7f26492`
và HEAD. Cherry-pick đúng dải commit của tôi thì không.

Repo **public** (`private: false`, kiểm qua GitHub API), và `.gitignore` có dòng
`# Never commit the real company workbook.` — nên để workbook lọt thêm vào branch build là quyết định về
dữ liệu, không phải kỹ thuật. Chủ ý của owner là **không** đưa ba file đó vào branch build.

### Đã đo trong sandbox (clone tạm từ `7f26492`)

| Bước | Kết quả |
|---|---|
| `git rev-list --count e77d83f..1f75707` | **7 commit**, đúng chủ đề ở bảng §2 |
| `git cherry-pick e77d83f..origin/arena/44b4109e-tat-qpn` | áp sạch, **0 conflict**, không file nào bị `kept`/`dropped` |
| `git diff --name-only origin/arena/44b4109e-tat-qpn HEAD` | chênh lệch = **đúng 3 file artifacts**, không thiếu một dòng code/test/docs |
| `git ls-files \| grep -E '\\.xlsx$\|_Source\.zip$'` trên nhánh thử | **rỗng** ✓ branch build không nhận workbook |
| `npx vitest run` trên cây đó | `52 passed \| 1 skipped`, `681 passed \| 2 skipped`, **0 fail** |
| `tsc --noEmit` | sạch |
| `tests/portable` + `tests/update` | 211 passed |
| `git ls-files --eol` 2 file `.bat` | `i/lf w/crlf attr/text eol=crlf` ✓ |
| `git merge --ff-only <nhánh thử>` từ branch build | `Updating 7f26492..ca7ddd9` + `Fast-forward` ✓ |
| `git check-ref-format 'integration\\tat'` | **INVALID** ✓ (là lý do hướng dẫn PowerShell dùng `/`) |
| `git ls-files --eol BUILD_AND_PUBLISH_TNP_TEST.bat` | `i/lf w/crlf attr/text eol=crlf` ✓ CRLF lúc checkout |

2 test nhảy qua là `src/services/import/tnpFileParser.test.ts` và
`realWorkbook.integration.test.ts`; cả hai dùng `existsSync(workbook) ? it : it.skip` theo đúng quy ước ghi
trong comment ("workbook là dữ liệu công ty, bị gitignore, không có trong checkout sạch"). Việc không mang
xlsx sang branch build **không làm gãy test nào**. Muốn 2 test đó chạy trên máy build thì đặt file vào thư
mục gốc máy đó, không commit.

### Các bước trên build machine

Bản có kiểm tra từng khối: `docs/integration-powershell.md` §0→§11. Khung tóm tắt:

```powershell
Set-Location -LiteralPath 'D:\TAT TNP\TAT_QPN-main'
git fetch --prune origin
git switch -c integration/tat-qpn-2026-10-08 origin/arena/36b4835b-tat-qpn
git cherry-pick e77d83f..origin/arena/44b4109e-tat-qpn
git diff --name-only origin/arena/44b4109e-tat-qpn HEAD    # phải ra ĐÚNG 3 file artifacts
npm ci; npm run typecheck; npm test; npm run test:server
npm run test:portable; npm run test:portable-runtime; npm run test:update
git ls-files --eol BUILD_AND_PUBLISH_TNP_TEST.bat UPDATE_AND_BUILD_TNP.bat
```

Ba chỗ dễ vấp:

- **tên nhánh dùng `/`, không dùng `\`** — `git check-ref-format` cấm `\` trong tên ref, nên
  `integration\tat-qpn-…` bị từ chối ngay dòng tạo nhánh;
- **`git ls-files --eol`** phải in `i/lf w/crlf attr/text eol=crlf`. Nếu ra `w/lf`, `.gitattributes` chưa
  áp dụng cho file đã có trong working copy: `git rm --cached -q .gitattributes; git checkout -- .` rồi kiểm
  lại, hoặc re-clone;
- **conflict thì dừng, không auto-merge**: sửa tay cho đúng ý định rồi `git cherry-pick --continue`, hoặc
  `git cherry-pick --abort` (branch thử về nguyên trạng, branch build không liên quan).

Cuối cùng chọn một trong hai cách đưa vào branch build (PowerShell guide §9): `git merge --ff-only` trên
branch build rồi push (không force), **hoặc** push nhánh thử + mở PR vào branch build. Tài khoản hiện tại
có quyền push (`push: true`), nên cả hai đều chạy được.

### Cách hoàn tác

```powershell
git cherry-pick --abort                          # nếu đang giữa chừng
git reset --hard origin/arena/36b4835b-tat-qpn   # nếu đã commit trên nhánh THỬ mà chưa push
git branch -d integration/tat-qpn-2026-10-08     # dọn nhánh thử sau khi merge xong
```

`reset --hard` chỉ an toàn ở đây vì lệnh chạy **trên nhánh thử**; đừng chạy trên branch build hoặc trên
working copy còn thay đổi chưa commit. Không force-push branch build. Không xoá `data\`, `backups\`,
`reports\` — đó là dữ liệu production của máy Owner và chưa từng là nội dung của commit nào.

## 4. Sau khi tích hợp: publish TEST, rồi mới được nói "đã chạy trên Windows"

Thứ tự bắt buộc, kỳ vọng chi tiết ở `docs/windows-test-checklist.md`:

1. Kiểm tra PowerShell/`Compress-Archive` và quyền ghi share trước (§1) — `ConstrainedLanguage` mode là
   lý do phổ biến nhất khiến bước build fail trên máy công ty.
2. Build TEST Portable, đối chiếu 11 mục file bắt buộc với dòng `Portable build ready:` (§2).
3. Kiểm thư mục LAN **cả hai phía**: nút Check update folder trong app (§3) và `publish.js --check-only`.
4. Publish TEST bằng `BUILD_AND_PUBLISH_TNP_TEST.bat "\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates"`
   — có dấu nháy (§4).
5. Kiểm `version.json` + `Get-FileHash`/`certutil`: `channel`, `product`, `architecture`, `package` chỉ là
   một tên file trần, size/sha256 khớp, không còn `.tmp` (§5).
6. Update từ máy Owner: phần trăm byte thật, 8 điểm đối chiếu sau restart, `.tnp-update\runtime-backup\` (§6).
7. 11 drill từ chối 7a–7k, đặc biệt **7a** (path không nháy phải bị chặn) và **7k** (gate hỏng phải dừng
   trước khi publish).

## 4b. Lỗi thứ tư tìm thấy khi rà lệnh Windows — đã sửa, đã test

Checklist Windows (và `BUILD_AND_PUBLISH_TNP_TEST.bat` trước đó) dùng `artifacts\TNP Defect Management
System TEST` làm folder portable. Packager không tạo folder nào tên như vậy: `scripts/package-portable.mjs`
mặc định là **`TNP-Defect-Management-TEST-win-x64`** (`FOLDER_NAME`), chỉ launcher bên trong mới có dấu cách
(`TNP Defect Management TEST.exe`, từ `APP_NAME`).

Hệ quả trên máy Windows: bước 7 không tìm thấy launcher → `The portable build did not produce its launcher
at: …` → **một-click publish không chạy được**; và nếu vì tình cờ có folder cũ còn sót đúng ở đường dẫn đó,
nó sẽ publish **bản cũ**. Đây là loại lỗi chỉ nổ trên máy thật — nên nó nằm ở trọng tâm vòng kiểm này.

Đã sửa: script dùng đúng folder mặc định của packager; có `set "TNP_PORTABLE_DIR=<đường dẫn>"` để override
khi build bằng `--folder-name`; và khi thiếu launcher thì in **danh sách nội dung `artifacts\`** vào log để
người vận hành thấy ngay build ghi ra đâu. `tests/portable/packageContract.test.ts` giờ đọc thẳng
`FOLDER_NAME`/`APP_NAME` từ packager và bắt cả hai file `.bat` khớp theo — lệch tên thành test fail thay vì
hỏng im lặng. Đã xác nhận bằng cách chạy packager thật với Electron thay thế
(`.cache\electron-v44.5.1-win32-x64\`, đúng đường dẫn offline mà Phase 6 mô tả): in ra
`Portable build ready: …\TNP-Defect-Management-TEST-win-x64`, và cả 11 mục `Test-Path` của checklist đều
`True`. Khi cố tình đặt lại tên folder sai, test mới fail đúng như mong đợi.

## 5. Đã kiểm chứng trong sandbox — và chưa kiểm chứng gì

**Đã chạy thật ở đây:** `npx vitest run` **53 file / 683 test**, `test:server` 127, `test:portable` 105,
`test:portable-runtime` 7, `test:update` 106, `typecheck` sạch 3 dự án, `vite build` + `build:desktop` ok,
`npm audit --audit-level=high` 0, `git diff --check` sạch; packager chạy thật với runtime thay thế (xem
§4b); cây cherry-pick thử nghiệm cũng xanh với cùng bộ test.

**Chỉ kiểm tra tĩnh / chỉ Windows:** mọi dòng trong hai file `.bat`. Năm test cấu trúc đọc **văn bản file**
để khẳng định các dòng dừng và thứ tự là đúng như dự định, nhưng ở đây không có `cmd.exe` — chưa ai chạy
`BUILD_AND_PUBLISH_TNP_TEST.bat` hay `UPDATE_AND_BUILD_TNP.bat`. Cũng chưa kiểm chứng được:
`Compress-Archive`/`Expand-Archive` thật, `ELECTRON_RUN_AS_NODE=1` của helper, khoá file NTFS khi swap
runtime, SMB timeout, quyền share, và một lần cập nhật end-to-end trên máy Owner. Bảng §10 của checklist
liệt kê từng hành vi theo hai cột "đã chứng minh ở đây" / "nợ trên Windows"; không báo cáo nào được phép
nói "BAT đã chạy thành công" trước khi §1–§7 xong trên máy Windows.
