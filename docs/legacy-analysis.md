# Phân tích legacy — TNP Defect Management System

> **Source of truth đã kiểm tra:** `Theo dõi TAT  hệ thống TNP.html` (tên file có hai dấu cách sau `TAT`), blob trên GitHub `binhvugia1997-ui/TAT_QPN`, snapshot commit `63cff158d94ca0589d7fae180e0029e1afc93627` (`main`). Đã đọc toàn bộ HTML, JavaScript ứng dụng, CSS, SheetJS bundle và dữ liệu `BASE_DATA`; không dùng riêng giao diện để suy đoán nghiệp vụ. Tệp legacy được dùng làm tài liệu tham chiếu, không sửa.
>
> **Quy ước:** “Editable” bên dưới nói về chỉnh sửa trực tiếp trong UI. Các trường có trong file nhập còn có thể được cập nhật khi import lại.

## A. Application architecture

Luồng hiện tại:

```text
Excel/CSV → IMPORT (chọn sheet đầu / parse CSV)
         → NORMALIZATION (header alias, date và quantity)
         → MATCHING (Management Number; fallback composite fingerprint)
         → DATABASE (merge record seed + overrides + newRecords; IndexedDB/localStorage)
         → BUSINESS LOGIC (status, TAT, due-date, filters, KPI, grouping)
         → UI (Home, Records, Analysis, Corrective Actions, TAT, Rejected, drawer/modal)

BASE_DATA ── read-only seed/reference ──┘
```

Cụ thể, ứng dụng là một HTML đơn chứa CSS, một script SheetJS v0.18.5 nhúng inline (để đọc XLSX offline), `BASE_DATA` nhúng inline và một script JavaScript global. Ứng dụng không có backend hay tài khoản. Khi mở, `init()` tải state từ IndexedDB/localStorage, tạo toàn bộ shell, đăng ký event delegation một lần rồi gọi `render()`. Hầu hết hành động thay đổi global `state` và dựng lại các vùng DOM bằng `innerHTML`.

Import xử lý tuần tự từng file. Dòng import được chuyển thành record, dò fingerprint trong index đã dựng từ BASE_DATA (đã áp dụng overrides) và `newRecords`; match thì cập nhật record hiện có, không match thì thêm record mới. Sau đó ghi overrides, newRecords và import log, rồi render lại.

## B. Data model

### B1. BASE_DATA và record chính

`BASE_DATA` là mảng seed/reference chỉ đọc gồm **191 record**, ID số nguyên 1–191, không có ID hoặc Management Number bị trùng trong snapshot này. Có 34 field gốc. Ngày lưu dạng ISO `YYYY-MM-DD`; `sampleQty`, `defectQty`, `defectRate` là số (một số field có thể null); `tatDays` lại đang là chuỗi trong seed.

| Field | Ý nghĩa | Kiểu canonical đề xuất | Nguồn | Editable trong legacy UI? | Màn hình/dùng ở đâu |
|---|---|---|---|---|---|
| `id` | Khóa nội bộ của record | `number \| string` | BASE_DATA; ID sinh cho import/manual | Không; update/import không đổi ID | Identity, drawer lookup, persistence |
| `no` | Số thứ tự theo export TNP | string | BASE_DATA / header `no` | Không | Không hiển thị; một số file import có field này |
| `mgmtNo` | Management Number | string | BASE_DATA, import, nhập tay | Nhập khi tạo mới; không sửa trong drawer | Records, Home/Rejected, Corrective Actions, TAT, Reject, drawer, search, duplicate key |
| `registeredDate` | Ngày đăng ký | date string \\| null | BASE_DATA, import, nhập tay (mặc định hôm nay) | Chỉ nhập khi tạo mới | Filter ngày/tháng, Home rejection list, Records, TAT, drawer |
| `writtenBy` | Người tạo trên hệ thống nguồn | string \\| null | BASE_DATA / import | Không | Không hiển thị |
| `status` | Trạng thái countermeasure | string (giữ cả giá trị lạ) | BASE_DATA, import, nhập tay | Drawer; chọn khi tạo mới | Records, Analysis, KPI, Home, Corrective Actions, Reject, TAT logic, filter |
| `plant` | Nhà máy/market | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Home market, filter, Records, Analysis/Reject grouping, drawer, search phụ trợ |
| `title` | Tiêu đề lỗi | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Search, Corrective Actions, TAT, drawer |
| `occurPlace` | Công đoạn/vị trí phát sinh | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Filter, Records, Analysis, drawer |
| `supplier` | Nhà cung cấp | string \\| null | BASE_DATA / import | Không | Không hiển thị |
| `vendorGroup` | Nhóm vendor | string \\| null | BASE_DATA / import `vendor_g` | Không | Không hiển thị |
| `partCode` | Mã linh kiện/defect code | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Filter defect code, Reject, drawer, search, fingerprint fallback |
| `partName` | Tên linh kiện | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Search, drawer |
| `partGroup` | Nhóm linh kiện | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Filter, Records, Analysis, drawer |
| `project` | Dòng model/dự án | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Filter, Records, Analysis, Home, Corrective Actions, TAT, Reject, drawer, search |
| `model` | Basic model | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Filter, Records, drawer, search |
| `defectDetails` | Mô tả hiện tượng lỗi | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Search, drawer |
| `sampleQty` | Số lượng mẫu kiểm tra | number \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Drawer |
| `defectQty` | Số lượng lỗi | number \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Records, drawer, fingerprint fallback |
| `defectRate` | Tỷ lệ lỗi (%) | number \\| null | BASE_DATA / import | Không | Không hiển thị |
| `reason1` | Nhóm nguyên nhân 4M1E | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Filter, Records, Analysis, Reject, drawer |
| `reason2` | Chi tiết nguyên nhân | string \\| null | BASE_DATA / import | Không | Drawer |
| `inspector` | Người kiểm tra | string \\| null | BASE_DATA, import, nhập tay | Chỉ nhập khi tạo mới | Search, drawer |
| `approver` | Người phê duyệt | string \\| null | BASE_DATA / import | Không | Drawer |
| `approvalDate` | Ngày phê duyệt | date string \\| null | BASE_DATA / import | Không | Không hiển thị |
| `issueYN` | Cờ issue Y/N | string \\| null | BASE_DATA / import | Không | Không hiển thị |
| `claimYN` | Cờ claim Y/N | string \\| null | BASE_DATA / import | Không | Không hiển thị |
| `reoccur3M` | Cờ/tình trạng tái phát trong 3 tháng | string \\| null | BASE_DATA / import | Không | Không hiển thị |
| `dueDate` | Hạn trả lời countermeasure cuối cùng | date string \\| null | BASE_DATA, import, nhập tay | Drawer | Records, overdue/KPI, Corrective Actions, drawer, export |
| `completedDate` | Ngày nhập countermeasure cuối cùng/hoàn tất | date string \\| null | BASE_DATA, import | Drawer | KPI on-time, danh sách completed, drawer, export |
| `tatDays` | TAT ngày do export nguồn cung cấp | legacy string; canonical number \\| null | BASE_DATA / import | Không; không tự tính trong drawer | Drawer, export; không phải nguồn để tính TAT dashboard |
| `tatCompliance` | Cờ TAT compliance từ nguồn | string \\| null | BASE_DATA / import | Không | Không hiển thị |
| `transactionType` | Loại giao dịch | string \\| null | BASE_DATA / import | Không | Không hiển thị |
| `locatedCorp` | Công ty/khu vực thuộc về | string \\| null | BASE_DATA / import; manual hiện gán bằng plant | Không | Không hiển thị |

### B2. Field bổ sung từ import và thao tác người dùng

Các field sau không có trong 34 field BASE_DATA nhưng `IMPORT_HEADER_MAP`, UI hoặc migration legacy có thể tạo ra. Chúng không được loại khỏi model mới chỉ vì hiện chưa được render:

| Field | Ý nghĩa/nguồn | Kiểu | Editable/dùng trong legacy |
|---|---|---|---|
| `mqisCode` | Mã MQIS; import aliases hoặc nhập tay | string \\| null | Inline Records/Rejected, drawer; search, Home reject list, export |
| `pic` | Người phụ trách do người dùng gán | string \\| null | Inline Records/Rejected, drawer; không import từ TNP map |
| `caFileLink` | URL/đường dẫn file corrective action | string \\| null | Inline Records/Rejected, drawer, copy/open; export |
| `notes` | Ghi chú theo dõi cục bộ | string \\| null | Inline Records/Rejected, drawer; export |
| `vCode`, `vendorSub`, `mainCategory` | Mã/nhánh vendor, phân loại chính | string/giá trị nguồn | Import only; không UI |
| `auditDate`, `vendorApprovalDate` | Ngày audit/vendor approval | date string \\| null | Import only; không UI |
| `issueReason`, `partsProblem`, `systemQtr`, `inputStop`, `effectivenessVerification` | Trường quy trình nguồn | string/giá trị nguồn | Import only; không UI |
| `sqciPlmNo`, `plmCountermeasure`, `sourceRemarks`, `usedMember` | Trường PLM/requester/remarks/member từ export | string/giá trị nguồn | Import only; không UI |
| `initialDueDate`, `initialCompletedDate` | Hạn/ngày nhập đối sách ban đầu | date string \\| null | Import only; không UI |
| `initialTatCompliance` | Compliance cho TAT ban đầu | string \\| null | Import only; không UI |

Trong BASE_DATA, `supplier`, `vendorGroup`, `no`, `writtenBy`, các cờ nguồn và nhiều trường khác được giữ dù không hiển thị. Import map có thêm các field trên; chỉ header nhận diện được mới được lưu. Các header hoàn toàn không nhận diện hiện bị bỏ qua.

**Editable hiện tại:** Drawer sửa `status`, `dueDate`, `completedDate`, `notes`, `pic`, `caFileLink`, `mqisCode`. Bảng Records/Rejected inline sửa `mqisCode`, `pic`, `caFileLink`, `notes`. Các trường còn lại có trong form “New defect” chỉ được nhập lúc tạo record; không có chế độ sửa phần thông tin gốc trong drawer. Import lại có thể cập nhật bất kỳ field nào được map và có trong dòng nhập, trừ `id`.

### B3. Field map import

`IMPORT_HEADER_MAP` dùng alias cố định, không có UI mapping:

- English/source aliases: `no`; `management number`; `registered date`; `mqis code`, `mqis no`, `mqis number`, `mqis`; `written by`; `approval▼`, `approval`, `status`; `plant`; `title`; `occur place`; `supplier`; `v/code`; `vendor_g`; `vendor_s`; `part code`; `part name`; `part group`; `main category`; `project`; `basic model`; `defect details`; `sample q'ty`/`sample q’ty`; `defect q'ty`/`defect q’ty`; `defect rate(%)`; `reason1`, `reason2`; `inspector`, `audit date`, `approver`, `approval date`; `issue 사유`; `issue y/n`; `parts problem`; `reoccur 3m`; `system qtr`; `claim y/n`; `input stop`; `effectiveness verification`; `reply expeced date for final countermeasure` (legacy misspelling) and `reply expected date for final countermeasure`; `final countermeasure input date`; `tat(day)`; `tat compliance`; `transaction type`; `located corp`.
- Korean aliases: `관리번호`, `등록일`, `등록자`, `승인단계`, `승인상태`, `제목`, `발생장소`, `협력사`, `업체명`, `부품코드`, `부품명`, `부품군`, `대분류`, `불량현상`, `검사수`, `불량수`, `불량률(%)`, `불량율(%)`, `원인1(4m+1e)`, `원인1`, `원인2(발생원인)`, `원인2`, `심사자`, `심사일`, `승인자`, `승인일`, `부품문제`, `qtr 3개월내 재발`, `3개월내 재발생`, `투입중지`, `유효성 검증`, `유효성검증`, `최종대책회답예정일`, `최종대책입력일`, `tat(일)`, `tat 준수`, `sqci/plm-no`, `plm 대책`, `의뢰자/시료번호/비고`, `최초대책예정일`, `최초 대책 입력일`, `최초대책입력일`, `최초tat 준수(y/n)`, `거래유형`, `업체구분_승락일`, `권역법인`, `사용멤버`.

Alias normalization chỉ trim, lowercase và gộp whitespace; không fuzzy match/diacritics normalization. Header row là dòng đầu trong tối đa 10 dòng có ít nhất 3 cell map được. Workbook chỉ đọc sheet đầu. Dòng 1 được bỏ qua trước, sau đó mới fallback scan cả sheet. XLSX dimension được tự tính lại từ các cell để tránh truncated range. CSV parser xử lý dấu quote kép, field có quote và CRLF/LF, nhưng delimiter cố định là dấu phẩy.

## C. Record identity

Thuật toán hiện tại trong `recordFingerprint(record)`:

```js
const management = (record.mgmtNo || '').trim().toLowerCase();
if (management) return 'mn:' + management;
return ['fp', record.registeredDate, record.plant, record.partCode, record.title, record.defectQty]
  .map(v => String(v || '').trim().toLowerCase()).join('|');
```

Ưu tiên **Management Number** sau trim + lowercase; nếu trống thì dùng composite theo đúng thứ tự `registeredDate + plant + partCode + title + defectQty` (có tiền tố `fp`). Không dùng `id`, `no`, MQIS, status hay due date để nhận diện. Với fallback, `0` và blank đều thành chuỗi rỗng do `v || ''`; dấu `|` trong dữ liệu không escape nên có thể tạo collision.

`buildRecordIndex()` thêm BASE_DATA đã merge override rồi thêm `newRecords` vào `Map`; nếu nhiều record trùng fingerprint thì record đưa vào sau thay record trước trong index. Trong import một batch, fingerprint của record mới được index ngay để dòng lặp sau không insert lần nữa. Match thì cập nhật field-by-field, không đổi `id`; nhiều dòng cùng identity có thể cập nhật nối tiếp (dòng/file xử lý sau thắng). Dữ liệu người dùng như notes/PIC/file link còn nguyên nếu không có field đó trong dòng import.

## D. Import flow

```text
Excel/CSV
 → đọc CSV bằng parser riêng hoặc XLSX bằng SheetJS (sheet đầu)
 → tìm header trong tối đa 10 dòng
 → map alias → bỏ dòng trống → chuẩn hóa date và quantity
 → sinh ID tạm cho từng row
 → fingerprint và so với toàn bộ BASE_DATA+overrides+newRecords
 → MATCH: merge mọi field có trong row, giữ id
   NO MATCH: thêm vào newRecords
 → ghi import log (theo từng file và tổng batch)
 → persist overrides/newRecords/importLog
 → render UI
```

Ngày import xử lý Date, Excel serial, `YYYY-M-D` và chuỗi parse được bởi `Date`; giá trị date không parse được được trả lại nguyên chuỗi. Chỉ `sampleQty` và `defectQty` được ép Number; `defectRate`/`tatDays` không được ép ở hàm import gốc. Dòng rỗng bị bỏ qua. Lỗi parse của một file được ghi trong summary rồi vòng lặp tiếp tục file kế; import log vẫn được tạo. Kết quả đếm `added`, `updated`, `unchanged`, `total` chỉ tính các record đọc thành công.

Khi match, tất cả key trong row trừ `id` được áp lên record hiện tại; giá trị blank/null trong file cũng có thể ghi đè giá trị field tương ứng. Field không có trong file (như notes/PIC/caFileLink) không bị xóa. Persist được gọi sau khi state đã đổi nhưng không được `await`/kiểm tra kết quả trong import flow.

## E. Status engine

Các giá trị thực tế trong 191 seed record (và `STATUS_OPTIONS`) có đúng 5 status:

| Status nguồn | Phân loại legacy | Ghi chú |
|---|---|---|
| `Hoàn thành` | Completed | Closed |
| `Đợi duyệt` | Completed | Được tính như closed trong KPI/CA/TAT dù tên status nói đang đợi duyệt |
| `Đợi xét` | Completed | Được tính như closed dù tên status nói đang đợi xét |
| `Đợi đối sách` | Open/Pending | Đang chờ countermeasure |
| `Rejected (xét)` | Reject **và đồng thời Open** | Có dashboard riêng; không thuộc completed set nên vẫn tính pending/overdue/TAT |

Trong snapshot 191 row: `Hoàn thành` 100, `Đợi đối sách` 32, `Rejected (xét)` 25, `Đợi duyệt` 23, `Đợi xét` 11. `COMPLETED_STATUSES` là tập chính xác gồm `Hoàn thành`, `Đợi duyệt`, `Đợi xét`. `isRejectedStatus` chỉ match chính xác `Rejected (xét)`. Status lạ từ file import vẫn được giữ; `statusMeta` hiển thị unknown style, nhưng drawer options chỉ liệt kê 5 status trên. Không có state machine hay chuyển trạng thái tự động theo ngày `completedDate`.

## F. TAT engine

- **TAT Due Date** = `registeredDate + 7 calendar days` (`addDaysStr`), không lấy `dueDate` của countermeasure. Ví dụ đăng ký ngày 1 thì TAT due là ngày 8; due date của action lấy từ field `dueDate` riêng và có thể khác.
- Ngày còn lại = `daysUntil(TAT Due Date)` so với ngày hiện tại tại local midnight; 0 là đến hạn hôm nay, số âm là quá hạn.
- TAT Monitoring chỉ theo dõi record đang lọc thỏa `!isCompletedStatus(record) && registeredDate`. Record thiếu registration date bị loại. `Hoàn thành`, `Đợi duyệt`, `Đợi xét` bị loại; `Đợi đối sách`, `Rejected (xét)` và status lạ tham gia.
- Tier: `<0 overdue`; `0 red/due today`; `1 orange`; `2 yellow`; `>2 green/on track`.
- `tatTier()` cũng tự loại completed. Mỗi nhóm được sort theo số ngày còn lại tăng dần. TAT dashboard KPI hiển thị số theo 5 nhóm; “tracked” là số record open có registered date.
- Record có `completedDate` nhưng status vẫn open vẫn được tính TAT; ngược lại status thuộc completed set bị loại dù `completedDate` trống.
- `tatDays` và `tatCompliance` nhập từ export chỉ là dữ liệu nguồn; dashboard TAT dùng phép tính registered date + 7, không dùng hai field này.
- **Overdue Corrective Action/KPI** dùng `dueDate` countermeasure (không phải TAT Due Date): status không completed và dueDate có ngày < hôm nay. `isDueSoon` cũng dùng dueDate, bao gồm từ hôm nay đến hết 3 ngày.

### Quy tắc TAT Phase 1 được người dùng xác nhận (khác legacy)

Source audit không tìm thấy field được đặt tên rõ là current/revised TAT deadline. Alias nguồn xác nhận `dueDate` lấy từ chính header legacy bị viết nhầm `Reply expeced date for final countermeasure` (cùng nghĩa với bản viết đúng `Reply expected date for final countermeasure` / Korean `최종대책회답예정일`); `initialDueDate` là ngày dự kiến countermeasure ban đầu. Legacy TAT monitor chỉ tính `registeredDate + 7` và không đọc `dueDate`. Trong BASE_DATA, cả 25 record `Rejected (xét)` đều có `dueDate` cách ngày đăng ký 10–18 ngày, trong khi `tatDays` và `tatCompliance` đều trống; mẫu dữ liệu này là dấu hiệu nhưng tự nó không chứng minh ý nghĩa TAT. Người dùng xác nhận quy tắc cho bản rebuild: mọi record đang mở dùng TNP `dueDate` làm effective TAT deadline nếu có ngày hợp lệ; chỉ khi `dueDate` trống/missing mới fallback về `registeredDate + 7`. Completed status tiếp tục bị loại khỏi TAT. `registeredDate` không được đồng bộ lên record đã tồn tại và giữ nguyên như dữ liệu lịch sử/identity. `dueDate` tiếp tục là corrective-action date. Đây là quy tắc nghiệp vụ mới được xác nhận, không phải logic tìm thấy trong HTML cũ.

## G. KPI

Dashboard KPI dùng **filtered records**:

- `Total` = số record sau search/filter.
- `Open/Pending` = số record mà status không nằm trong completed set; do đó gồm Reject, unknown và record thiếu due date.
- `Completed` = số record có status chính xác trong completed set (3 giá trị).
- `Overdue` = `!completed` và `dueDate` có giá trị, `daysUntil(dueDate) < 0`.
- `On-time closure rate` = `round(count(completedDate && dueDate && completedDate <= dueDate) / count(completedDate && dueDate) * 100)`. Mẫu số chỉ cần hai ngày, không cần status completed; nếu không có mẫu số hiển thị `—`.
- “Today” chỉ hiển thị ngày hiện tại.
- Subtitle Total full database legacy dùng `BASE_DATA.length + newRecords.length`.

Home market stats dùng toàn bộ records, không dùng dashboard filters: group theo `plant` (giá trị trống gom vào “Not analyzed”), tổng; completed theo cùng status set; pending là phần còn lại; overdue theo `dueDate`. Reject KPI đếm chính xác status `Rejected (xét)` và breakdown theo market `plant` / reason1. Analysis chart nhóm record đã lọc theo reason1, occurPlace, partGroup, project, tháng registeredDate và status; nhãn thiếu gom thành “Not specified”. Bar width tính theo giá trị lớn nhất, không phải tỷ trọng trên tổng.

## H. Screens

| Màn hình | Input/logic | Hành động |
|---|---|---|
| **Home** | Toàn database: overview số plant/record/overdue; card theo plant với total/pending/completed/overdue; reject list mới nhất tối đa 8 record | Chọn card mở dashboard Records đã filter plant; chọn reject row mở drawer; “view all” mở tab Rejected; logo/Home reset filters |
| **Records** | Records sau search/filter; mặc định sort registeredDate giảm dần; 14 cột gồm mgmt/MQIS/date/plant/project/model/part group/occur place/reason/status/due/qty/PIC/file link/remark | Click header để sort; click row mở drawer; inline edit MQIS/PIC/file link/remark |
| **Analysis** | Records đã lọc, group theo nguyên nhân/vị trí/part group/project/tháng/status | Chỉ xem chart; không drill-down/action |
| **Corrective Actions** | Records đã lọc chia overdue, due trong 0–3 ngày, upcoming; record open không có dueDate cũng vào upcoming; completed sort completedDate giảm dần | Click row mở drawer; completed chỉ render tối đa 25, phần còn lại báo số lượng |
| **TAT Monitoring** | Records đã lọc, loại 3 status completed và thiếu registeredDate; nhóm theo TAT due registeredDate+7 | Click row mở drawer; 5 nhóm overdue/today/+1/+2/on-track |
| **Rejected** | Subset đã lọc với status đúng `Rejected (xét)`; KPI và grouping plant/reason | Click row mở drawer; inline MQIS/PIC/file link/remark; cột không sort |
| **Import** | Modal “Add daily TNP file”; file xlsx/xls/csv, history 8 batch mới nhất, local root, Windows native-open setup, clear-local-data | Chọn/thả nhiều file; xem summary lỗi/thêm/cập nhật/không đổi; clear yêu cầu `confirm()` |
| **Record Detail** | Drawer: core defect fields read-only và CA tracking fields | Save status/dueDate/completedDate/notes/PIC/file link/MQIS; xóa chỉ record thuộc `newRecords` (không có confirm trong code hiện tại) |
| **New defect** | Modal nhập một phần schema; mgmt number tự tạo nếu để trống; registered date mặc định hôm nay; status mặc định `Đợi đối sách` | Thêm record trực tiếp vào `newRecords`; không validation duplicate hay xác nhận tạo |

Navigation thực tế: Home + market card dẫn tới một dashboard tabbed dùng chung; tab gồm Records, Analysis, Corrective Actions, TAT Monitoring, Rejected. Import không phải page/tab. Search/filter áp dụng cho các tab dashboard, không cho Home.

### H1. Filters và sorting

- Search là substring không phân biệt hoa/thường trên `mgmtNo`, `mqisCode`, `title`, `defectDetails`, `partName`, `partCode`, `model`, `project`, `inspector`; không chuẩn hóa dấu tiếng Việt.
- Date-from/date-to so sánh `registeredDate` dạng ISO và bao gồm hai biên. Record thiếu `registeredDate` vẫn qua điều kiện date range do legacy chỉ so sánh khi record có ngày.
- Các facet: plant, project, partGroup, model, occurPlace, reason1, status, tháng registeredDate, defectCode (`partCode`). Điều kiện giữa facet là AND; nhiều giá trị trong cùng một Set là OR. Filter option/count được tạo từ toàn bộ record, không phải kết quả đã lọc. Các facet không có lựa chọn trống.
- Sort mặc định `registeredDate` giảm dần; chọn cột mới thì tăng dần, nhấp lại cùng cột đảo chiều. So sánh số chỉ khi cả hai giá trị là number; còn lại dùng `localeCompare` trên chuỗi. Sort không thay đổi dữ liệu gốc.

### H2. Export CSV

Nút Export CSV nằm ở topbar. Xuất các record qua cùng search/facets hiện tại rồi sort theo state hiện tại. Thứ tự field cố định: `mgmtNo`, `mqisCode`, `registeredDate`, `plant`, `project`, `model`, `partGroup`, `partCode`, `partName`, `occurPlace`, `reason1`, `reason2`, `title`, `defectDetails`, `sampleQty`, `defectQty`, `status`, `dueDate`, `completedDate`, `tatDays`, `inspector`, `approver`, `pic`, `caFileLink`, `notes`. Không xuất tất cả 34 field nguồn (ví dụ `no`, `writtenBy`, `supplier`, `defectRate`, `tatCompliance` không có trong danh sách). Mỗi ô thay `"` bằng `""`; chỉ bọc dấu ngoặc kép khi có comma/quote/newline. Tạo `text/csv;charset=utf-8` không thêm BOM, tên `tnp_defects_export_YYYY-MM-DD.csv`.

### H3. Language/i18n và event wiring

- `I18N` có `en`, `ko`, `vi`; mặc định `en`, chọn ở topbar và lưu vào `tnp_dms_lang_v1`. `t(key)` fallback sang English rồi key; `tf(key, vars)` thay `{placeholder}`. Nhãn UI được dịch, nhưng status/record values hiển thị theo đúng text nguồn.
- `wireEvents()` đăng ký delegation một lần trên `#app` cho `click`, `input`, `change`, `keydown`, `dragover`, `drop`. Click row mở drawer; click tab/filter/sort cập nhật state; click nút save gọi update; inline edit lưu khi `change` (Enter làm blur); file picker và drop gọi import handler; Escape không có handler đóng modal/drawer.
- Delegation tránh gắn listener riêng từng row, nhưng `render()` dựng lại Home, sidebar, KPI và tab bằng `innerHTML` sau nhiều sự kiện. Search/filter gọi render theo từng `input`, gây công việc lặp lại.

### H4. Corrective Action file links

`caFileLink` là per-record field trong UI hiện tại. Migration cũ copy giá trị từ bảng shared `defectCodeLinks[partCode]` vào từng record nếu record chưa có link riêng; link riêng đã có không bị ghi đè. `localRoot` chỉ được nối vào đường dẫn tương đối; URL `http/https/file/ftp/mailto` giữ nguyên, `javascript:` bị từ chối. Windows drive/UNC/Unix paths được đổi sang `file://`; Copy sao chép đường dẫn đã resolve, Open tạo link URI. Khi bật tùy chọn Windows native-open (sau khi người dùng chạy helper), `file://` đổi thành `tnpopen://`; source tạo script setup/remove ở Import modal. Trình duyệt chặn truy cập đường dẫn máy khi app đang chạy HTTP, nên link cục bộ không được bảo đảm mở trực tiếp trong development preview.

## I. Persistence

- IndexedDB database `tnp_dms_db`, schema version 1, một object store `kv` (key-value); localStorage chỉ fallback/migration.
- Keys: `tnp_dms_overrides_v1`, `tnp_dms_new_records_v1`, `tnp_dms_import_log_v1`, `tnp_dms_lang_v1`, `tnp_dms_local_root_v1`, `tnp_dms_defect_code_links_v1`, `tnp_dms_use_native_open_v1`.
- **BASE_DATA** luôn được giữ trong source và không sửa trực tiếp. `getAllRecords()` merge từng base record với `overrides[id]`, rồi nối toàn bộ `newRecords`.
- **overrides** là partial patch theo id cho record seed; mọi sửa seed và import update seed ghi tại đây.
- **newRecords** giữ record import và record tạo tay; sửa field trực tiếp trong array này.
- **importLog** lưu batch mới nhất ở đầu danh sách, có `id`, `importedAt`, per-file summary/errors, tổng `added/updated/unchanged/total`.
- Preferences: language (`en/ko/vi`), `localRoot`, `useNativeOpen`; `defectCodeLinks` là key cũ cho CA link dùng chung theo partCode.
- Lần đọc: thử IndexedDB; nếu key chưa có thì đọc localStorage, parse JSON tùy key, thử migrate sang IndexedDB và xóa localStorage. Nếu IDB lỗi, log console và thử localStorage. Lần ghi: IDB trước rồi fallback localStorage; chỉ trả boolean. Fallback/migration có thể thất bại nhưng có nhánh catch.
- `migrateSharedFileLinksToPerRecord()` copy link dùng chung sang `caFileLink` từng record nếu record chưa có link riêng; không overwrite link riêng; sau đó dọn map shared. BASE_DATA không bị mutate.
- “Clear all imported data” có xác nhận, xóa overrides/newRecords/importLog/legacy shared links, reset filters; giữ nguyên BASE_DATA và language/localRoot/native-open preference.

## J. Legacy problems / risk

1. **Monolith:** HTML 9,378 dòng/1.21 MB; bundled SheetJS khoảng 639 KB, data và app logic nhúng chung; không có module boundary hay test foundation.
2. **Global mutable state:** state lưu cả persistence và UI; UI handler tự cập nhật business state rồi tự gọi persistence/render.
3. **Render coupling/performance:** mỗi event gọi nhiều renderer và thay `innerHTML` toàn khu vực; search/filter mỗi input rebuild Home, sidebar, KPI và table. Không có paging/virtualization. Chi phí tăng theo imported record count.
4. **Business logic duplicated by convention:** status/overdue/TAT helpers được tái sử dụng một phần nhưng semantics khó audit; riêng KPI on-time khác logic “completed status”. Status options hard-code 5 giá trị, trong khi imported status lạ được bảo toàn nhưng drawer không thể chọn lại status đó một cách an toàn.
5. **Fragile identity:** fingerprint nối chuỗi bằng `|` không escape; fallback coi `0` như blank; Map nếu trùng identity trong dữ liệu hiện có chỉ index record cuối; lookup không có unique constraint trong DB. ID import/manual tạo từ timestamp + random nên có xác suất collision rất nhỏ, không có retry.
6. **Import limitations:** alias map tĩnh, không có column-mapping UI; unknown header bị bỏ im lặng; chỉ sheet đầu; CSV comma-only. Import có thể cập nhật field thành blank/null; cùng identity nhiều row thì row sau thắng. `defectRate`/`tatDays` không normalize numeric như sample/defect quantity.
7. **Persistence integrity:** state đổi trước khi storage hoàn tất; nhiều key persist riêng, không transaction nguyên batch; import/manual edit không await/check `false`; localStorage fallback có thể quota limit. `loadPersistedValue`/migration có catch và chỉ log, một số nhánh migration best-effort.
8. **Destructive action:** clear data có confirm rõ, nhưng xóa record trong drawer không confirm. Base records không xóa được. New project phải bắt buộc explicit confirmation cho thao tác destructive và transaction/bulk validation trước khi ghi.
9. **Date edge cases:** `todayStr()` lấy UTC date; `daysUntil()` đọc local midnight; `addDaysStr()` dùng local Date rồi serialize UTC. Có thể sai khác gần nửa đêm/timezone hoặc DST; cần date-only arithmetic và test cố định ngày trong dự án mới, giữ nguyên quy tắc +7 calendar days.
10. **File links/platform coupling:** browser không thể mở tùy ý đường dẫn local khi ứng dụng đang chạy qua HTTP; Windows `tnpopen://` cần user tự tải/chạy .bat/PowerShell/VBS và có bước registry. Đây là feature legacy, không đưa vào Phase 1; phải review riêng trước khi triển khai.
11. **External asset:** Google Fonts tải từ CDN; SheetJS thì đã bundle offline. Bản mới nên không phụ thuộc font/API/cloud để shell khởi động offline.
12. **Legacy migration boundary:** IndexedDB/localStorage được scope theo browser origin. Dữ liệu override/newRecords trên bản legacy đang chạy không tự nhìn thấy từ origin của dev app khác; source HTML cung cấp BASE_DATA nhưng không có snapshot runtime của browser người dùng. Cần quy trình export/import/migration tường minh trước khi chuyển dữ liệu thật.

## Needs confirmation

Quy tắc effective TAT deadline cho mọi record mở (bao gồm Reject) đã được người dùng xác nhận ở mục F và không còn là câu hỏi mở. Các điểm sau vẫn cần người dùng xác nhận trước khi áp dụng cho quy trình nghiệp vụ production:

1. `Đợi duyệt` và `Đợi xét` được tính là **Completed/đóng** trong tất cả KPI, Corrective Actions và TAT hay chỉ ngừng TAT? Legacy loại cả hai khỏi Open/TAT/Overdue.
2. On-time denominator có chủ ý gồm mọi record có đủ `completedDate` + `dueDate`, kể cả record status vẫn open/rejected không?
3. Khi import, field mapped trống/null có chủ ý được phép ghi đè dữ liệu cũ không? Legacy áp các giá trị hiện diện trong row, kể cả blank.
4. Khi chuyển từ legacy sang app mới, cung cấp snapshot runtime nào của overrides/newRecords/importLog (nếu có)? Bản HTML tham chiếu chỉ chứa seed data; dữ liệu local của trình duyệt không nằm trong source GitHub.
5. Alias `issue 사유` và các header Korean thực tế cần giữ nguyên như map hiện tại hay có một mẫu export chuẩn mới cần được hỗ trợ?
