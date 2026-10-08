# Hướng dẫn PowerShell — cherry-pick 6+ commit vào branch build

Mục đích: tích hợp `arena/44b4109e-tat-qpn` vào branch build `arena/36b4835b-tat-qpn` bằng
**cherry-pick**, không merge, để **không** kéo theo 3 file dữ liệu ở thư mục gốc mà `main` đang mang
(workbook công ty, zip nguồn, HTML legacy). Lý do và bằng chứng nằm trong `docs/integration-runbook.md`.

Cách dùng: mở **Windows PowerShell** (không phải cmd.exe), chạy lần lượt từng khối theo số thứ tự,
và **giữ nguyên cửa sổ đó** tới hết — các khối sau dùng biến `$base`, `$src`, `$trail` đã định nghĩa ở
khối 0. Mỗi khối có dòng **Kỳ vọng**; nếu kết quả khác, dừng lại và báo nguyên văn output, đừng làm
tiếp "cho xong".

Không khối nào ở đây publish gì, không khối nào sửa SQLite, và không khối nào đụng `data\`, `backups\`,
`reports\`.

## 0. Biến bối cảnh

```powershell
Set-Location -LiteralPath 'D:\TAT TNP\TAT_QPN-main'
$base    = 'arena/36b4835b-tat-qpn'          # branch build — nơi nhận
$src     = 'arena/44b4109e-tat-qpn'          # branch chứa công việc cần lấy
$trail   = 'integration/tat-qpn-2026-10-08'  # nhánh thử, tên KHÔNG được chứa dấu \
$myWork  = "e77d83f..origin/$src"            # đúng phần commit của tôi, không gồm merge của main
```

**Kỳ vọng:** prompt trở lại không lỗi, và `Get-Location` là `D:\TAT TNP\TAT_QPN-main`.

> Tên nhánh dùng `/` chứ không dùng `\`. `git check-ref-format` cấm dấu `\` trong tên ref, nên
> `integration\tat-qpn` sẽ bị từ chối ngay ở khối 3 — đó là lý do dòng comment trên ghi rõ.

## 1. Lấy hết nhánh và kiểm tra tree sạch

```powershell
git remote set-branches origin '*'
git fetch --prune origin
git status --porcelain
git rev-parse --short "origin/$base" "origin/$src"
```

**Kỳ vọng:** `git status --porcelain` **in ra gì cũng phải dừng** (đang có thay đổi chưa commit;
cherry-pick đè lên đó là cách dễ mất việc nhất). Dòng cuối in hai SHA, ví dụ `7f26492` và SHA mới
nhất của branch tôi.

## 2. Đọc danh sách commit sẽ áp — đây là bước xác nhận phạm vi

```powershell
git rev-list --reverse --oneline $myWork
git rev-list --count $myWork
git log -1 --format='%s' "origin/$src"
```

**Kỳ vọng, đo tại `1f75707`:** `7` commit, theo đúng thứ tự

```
Add the manual condition column, natural sorting and resizable record columns
Make the LAN update path survive batch, JSON and the share
Point the drawer's MQIS field at mgmtNo and lock it
Lock the Management Number against edits at the service and API layer
Stop the publish when a gate fails, and guard the spaced path end to end
Add the Windows acceptance runbook and the branch integration runbook
Point the publish script at the folder the packager creates, and add the PowerShell runbook
```

Số commit sẽ nhiều hơn nếu branch nguồn còn được push tiếp — đó là lý do khối này dùng dải `$myWork` thay
vì đánh số SHA tay. Điều phải chắc chắn là **dải bao trọn công việc** và **không có commit ngoài dải**.
Đối chiếu danh sách in ra với bảng §2 của `docs/integration-runbook.md` rồi mới sang khối 3.

## 3. Tạo nhánh thử từ đúng tip branch build

```powershell
git switch -c $trail "origin/$base"
git rev-parse --short HEAD
git log -1 --format='%h %s'
```

**Kỳ vọng:** `HEAD` bằng đúng SHA của `origin/arena/36b4835b-tat-qpn` ở khối 1.

## 4. Cherry-pick

```powershell
git cherry-pick $myWork
```

**Kỳ vọng:** chạy hết, in 8 block `N files changed`, không có chữ `CONFLICT`.

Nếu có conflict: đọc `git status`, sửa tay cho đúng ý định, `git add <file>` rồi
`git cherry-pick --continue`. Muốn bỏ cuộc an toàn: `git cherry-pick --abort` — branch thử quay về
đúng trạng thái khối 3, branch build không hề hấn gì.

## 5. Kiểm tra then chốt: chênh lệch chỉ được là 3 file artifacts

```powershell
git diff --name-only "origin/$src" HEAD
git diff --stat "origin/$src" HEAD
```

**Kỳ vọng:** danh sách in ra **đúng 3 dòng**:

```
EXCEL_EXPORT_FILE_20261002181424.xlsx
TNP_Defect_Management_Source.zip
Theo dõi TAT  hệ thống TNP.html
```

Bất kỳ file nào khác xuất hiện ở đây = cherry-pick đã thiếu/thừa cái gì đó → **dừng, báo lại**, đừng
push. Đây chính là phép đo đã chạy trong sandbox: 0 conflict và chênh lệch đúng 3 file.

Và xác nhận branch build **không** nhận dữ liệu công ty:

```powershell
git ls-files | Where-Object { $_ -match '\.xlsx$|_Source\.zip$' }
```

**Kỳ vọng:** rỗng (repo public — `private: false` theo GitHub API — nên để workbook lọt vào branch build
là để lộ thêm một bản nữa).

## 6. Cổng kiểm thử trên nhánh đã tích hợp

```powershell
npm ci
npm run typecheck
npm test
npm run test:server
npm run test:portable
npm run test:portable-runtime
npm run test:update
npm run build
npm run build:desktop
npm audit --audit-level=high
```

**Kỳ vọng:** mọi lệnh exit 0. Trên cây không có workbook, `npm test` báo
`2 skipped` (đúng quy ước `existsSync(workbook) ? it : it.skip`) — đó là **kết quả đạt**, không phải lỗi.
Đo trên nhánh thử ở `1f75707`: `52 passed | 1 skipped`, `681 passed | 2 skipped`, và
`tests/portable` + `tests/update` = 211 passed. Con số của branch nguồn (có workbook) là 683.

## 7. Line endings của hai file .bat (ngắn nhưng bắt buộc)

```powershell
git ls-files --eol BUILD_AND_PUBLISH_TNP_TEST.bat UPDATE_AND_BUILD_TNP.bat
$t = [IO.File]::ReadAllText("$PWD\BUILD_AND_PUBLISH_TNP_TEST.bat")
"CRLF={0}  lone LF={1}" -f ([regex]::Matches($t, "`r`n")).Count, ([regex]::Matches($t, "(?<!`r)`n")).Count
```

**Kỳ vọng:** `i/lf w/crlf attr/text eol=crlf` cho cả hai file, và `lone LF=0`.
Nếu `w/lf`: `git rm --cached -q .gitattributes; git checkout -- .` rồi kiểm lại; nếu vẫn `w/lf` thì
mở file bằng Editor có "Save as CRLF". cmd.exe đọc label theo dòng, nên file LF-only có thể chết ở
chính những nhánh `call :fail` dùng để dừng publish.

## 8. Chỉ kiểm tra thư mục LAN, không publish

```powershell
node dist-desktop\desktop\update\publish.js --target '\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates' --channel test --check-only
"exit=$LASTEXITCODE"
```

**Kỳ vọng:** `target`, `kind: UNC, 2 segments deep`, `reachable: yes`, `writable: yes`,
`published: …` hoặc `nothing yet`, `next build: …`, `the update folder is usable.`, `exit=0`.
Lệnh này **không** publish; nó chỉ tạo một file probe nhỏ trong thư mục cập nhật rồi xoá đi — đó là
cách duy nhất phát hiện quyền ghi thật, vì `fs.access(W_OK)` báo "writable" cả trên mount read-only.
Nếu output có `BLOCKED`, dùng `docs/windows-test-checklist.md` §3 để phân biệt `unreachable` /
`not-readable` / `invalid-manifest` trước khi tích hợp tiếp.

## 9. Đưa kết quả vào branch build — chọn MỘT trong hai

Repo này cho tài khoản hiện tại quyền `push: true` (kiểm tra bằng GitHub API), nên cả hai cách đều
chạy được. **Không force-push branch build. Không xoá PR #6** — nó để đối chiếu.

### Cách A — FF branch build sang nhánh thử (nhanh nhất, không tạo merge commit)

```powershell
git switch $base
git pull --ff-only origin $base
git merge --ff-only $trail
git push origin $base
git rev-parse --short "origin/$base"
```

**Kỳ vọng:** `merge --ff-only` in `Updating 7f26492..<sha>` (không có `Merge made by`), và SHA cuối
bằng SHA tip của `$trail`. Nếu `--ff-only` từ chối: ai đó vừa push branch build → `git log --oneline
--graph origin/$base` để xem, và **dừng lại hỏi**, không merge tay để "thông" chốt.

### Cách B — push nhánh thử, mở PR vào branch build (nếu muốn có review)

```powershell
git push -u origin $trail
gh pr create --base $base --head $trail --title "Tích hợp 8 commit vào branch build (cherry-pick, không kèm artifacts)" --body "Cherry-pick từ PR #6. Diff với branch nguồn chỉ là 3 file artifacts ở gốc repo — xem docs/integration-runbook.md."
```

**Kỳ vọng:** PR mới, `base = arena/36b4835b-tat-qpn`, và diff của nó **không** chứa 3 file artifacts.

## 10. Dọn dẹp

```powershell
git branch -d $trail        # chỉ sau khi đã merge thành công
git switch $base
git fetch --prune origin
git log --oneline -3
```

## 11. Những lệnh KHÔNG được chạy trong quy trình này

| Lệnh | Vì sao |
|---|---|
| `git push --force` / `push -f` vào `arena/36b4835b-tat-qpn` | xoá lịch sử của người khác; branch build là nhánh chia sẻ |
| `git reset --hard` khi đang có thay đổi chưa commit | mất việc đang làm |
| `git clean -fdx` | xoá `node_modules`, và quan trọng hơn: `data\`, `backups\`, `reports\` là untracked — lệnh này xoá dữ liệu production của máy Owner |
| `Remove-Item data,backups,reports -Recurse` | như trên; không có lệnh nào trong hướng dẫn này cần xoá ba thư mục đó |
| `npm run update:publish` hoặc `BUILD_AND_PUBLISH_TNP_TEST.bat` | đó là bước publish, thuộc về `docs/windows-test-checklist.md` §1–§7 **sau** khi tích hợp xong, trên branch build |
| `git cherry-pick` một danh sách SHA tự gõ | dễ sót/thừa; luôn dùng dải `$myWork` và đối chiếu ở khối 2 + khối 5 |
