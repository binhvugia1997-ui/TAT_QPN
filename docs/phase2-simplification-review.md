# Phase 2 — Rà soát tổng thể & đơn giản hóa

**Trạng thái: được phê duyệt và dùng làm phạm vi triển khai Phase 2.** Báo cáo này đối chiếu nền React/TypeScript với ứng dụng legacy đã được kiểm tra và ghi lại ranh giới đơn giản hóa đã triển khai. Đây không phải cho phép xóa dữ liệu nguồn hoặc tự thay đổi nghiệp vụ còn chưa rõ.

Tham khảo [`legacy-analysis.md`](./legacy-analysis.md) để xem audit đầy đủ về field/workflow legacy; [`architecture.md`](./architecture.md) ghi lại các hợp đồng hiện tại về an toàn dữ liệu, import, TAT và persistence.

## Hướng tổng thể

Tổ chức trải nghiệm gọn, ưu tiên desktop, quanh luồng:

```text
Home → Records → Chi tiết record → PIC / Remark / CA
                         ↑
Add TNP File → Validate → Import → đồng bộ status / TAT
```

Giữ sáu module nghiệp vụ dự kiến: **Home, Records, Analysis, TAT, Corrective, Rejected**; nhưng không tạo sáu hệ thống record độc lập. Records là nơi xử lý công việc chính. TAT, Corrective và Rejected là các chế độ xem có cấu hình khác nhau trên cùng truy vấn dữ liệu, bảng, chi tiết và business modules. Analysis tổng hợp cùng tập record đã lọc và dẫn ngược về Records thay vì trở thành một màn hình chỉnh sửa khác.

UI có thể ẩn dữ liệu ít dùng, nhưng record canonical vẫn phải giữ **191 record seed, đủ 34 field gốc, các field import đã nhận diện và field do người dùng quản lý**. Không sửa `BASE_DATA`, xóa dữ liệu im lặng, đổi ID hiện có hay để một dòng import tổng quát ghi đè record đã tồn tại.

## Phân loại tính năng

### KEPT

- **Điều hướng sáu module:** Home, Records, Analysis, TAT, Corrective, Rejected. Giữ mục đích riêng cho từng module, không nhân bản cách triển khai.
- **Record và dữ liệu:** toàn bộ 191 seed record, ID và source text; đủ 34 field gốc; import extensions đã nhận diện; `pic`, `notes`, `caFileLink`, `mqisCode`; import history; lưu cục bộ bằng IndexedDB; các thao tác add/update/upsert an toàn.
- **Nghiệp vụ status:** giữ nguyên tập Completed chính xác (`Hoàn thành`, `Đợi duyệt`, `Đợi xét`), điều kiện nhận diện Rejected chính xác và status lạ từ import. Rejected vẫn là record đang mở cho TAT, trừ khi status thuộc tập Completed.
- **TAT hiệu lực đã xác nhận:** với record mở thuộc phạm vi áp dụng, dùng `dueDate` hợp lệ từ header `Reply expeced date for final countermeasure`; chỉ khi trống/thiếu mới fallback về `registeredDate + 7 ngày lịch`. Status Completed không tham gia TAT. Không dùng `tatDays` từ nguồn hoặc quy tắc legacy `+7` thay cho `dueDate` hợp lệ.
- **Đồng bộ TNP an toàn trên record hiện có:** tìm match theo identity đã thống nhất rồi chỉ áp whitelist đúng hai field `status` và `dueDate`. Không đồng bộ `registeredDate` khi match. Bảo toàn PIC, notes/Remark, CA file link, corrective data và mọi field app-managed/source khác. Giữ normalization của dòng mới và ghi record/import history trong một transaction nguyên tử.
- **Năng lực xử lý cần thiết:** search, filter theo plant/status/TAT/date/source fields, sort, chi tiết record, quản lý PIC/Remark/CA, analysis, kết quả/lịch sử import cục bộ và cách xem Completed.
- **Ranh giới local-first/offline:** không tài khoản, cloud sync, dịch vụ trả phí, tải font CDN lúc chạy hay phụ thuộc server.

### SIMPLIFIED

#### Home: tín hiệu nhanh, không phải bảng Records thứ hai

- Thay phần chào mừng/tổng quan chiếm chỗ bằng tiêu đề gọn, ngày/ngữ cảnh và ít chỉ số có ý nghĩa: total, active, completed, overdue, due soon (hoặc bộ KPI đã được xác nhận nếu phù hợp hơn).
- Có thể giữ breakdown plant gọn nếu giúp điều hướng công việc; ưu tiên plant đang urgent/pending, không lặp lại danh sách record đầy đủ.
- Bỏ bảng “rejected records mới nhất” kiểu legacy khỏi Home. Giữ module Rejected và một số đếm/link gọn.
- Click KPI/plant mở Records với filter tương ứng đã bật. Hiển thị rõ filter đó và có **Clear all**.

#### Records: workspace xử lý chính

- Dùng bảng desktop gọn, dễ đọc. Các cột chính đề xuất theo thứ tự: **TAT, Management No., Date, Plant, Model, Defect, Status, PIC, Deadline**.
- Giữ ý nghĩa TAT và Deadline riêng: TAT hiển thị một giá trị urgency gọn (`Overdue 3d`, `Due today`, `5d left`); Deadline hiển thị ngày thực tế. Không chồng nhiều badge hoặc lặp urgency trong ô status.
- Dùng nội dung một dòng/cắt gọn cho text dài, độ rộng ổn định cho ngày/mã, trạng thái hover/focus rõ. Ở cửa sổ nhỏ, cho phép cuộn ngang bảng thay vì làm mất phân cấp desktop.
- Mặc định xem **Active**, sort theo độ khẩn (quá hạn nhiều nhất/hạn gần nhất trước, sau đó tie-break ổn định). Có lựa chọn **Active / All / Completed** để vẫn xem được Completed mà không lấn chỗ work queue mặc định. Đây chỉ là filter, không xóa hay migrate record.
- Giữ các điều khiển thường dùng luôn hiển thị: **Search, Plant, Status, TAT**. Đưa facet ít dùng và registered-date range vào **More filters**. Hiển thị filter đang bật/số lượng và **Clear all**; semantics filter dùng chung từ `business/filters`.
- Chỉ giữ inline edit cho field thực sự cần thao tác nhanh (ví dụ PIC) nếu vẫn phù hợp với contract của service/model. Chuyển Remark và CA sang chi tiết thay vì biến mỗi row thành form.

#### Các module dùng chung màn hình, không nhân bản

- **TAT:** dùng cùng bảng/chi tiết; mặc định lọc/sort theo urgency TAT và status scope thích hợp.
- **Corrective:** dùng cùng bảng/chi tiết; ưu tiên record đang mở và field theo dõi corrective. Tái sử dụng helper TAT/deadline; không tự tính lại cùng deadline ở một nhánh khác.
- **Rejected:** dùng cùng bảng/chi tiết, lọc đúng status Rejected và có summary gọn. Không sao chép bảng Rejected cũ hoặc tạo một implementation inline-edit thứ hai.
- **Analysis:** summary gọn từ tập record đã lọc; chọn segment sẽ mở Records với filter phù hợp. Tránh thêm charting package nặng nếu chưa có nhu cầu nghiệp vụ đã kiểm chứng.

#### Import: luồng ngắn, dễ hiểu

- Một hành động **Add TNP File** dễ thấy (từ Home và/hoặc Records): **chọn file → validate → import → kết quả ngắn gọn**.
- Dùng alias header đã biết và helper hiện có; không yêu cầu người dùng map cột đã biết trong mỗi lần import. Báo header lạ/thiếu thay vì âm thầm báo thành công. Tóm tắt added/updated/unchanged/skipped; chỉ mở rộng lỗi theo file/dòng khi cần.
- Validate batch trước khi ghi; chỉ thành công khi records và history commit nguyên tử. Transaction lỗi không được hiển thị như import thành công.
- Với record match, chỉ dùng patch `status`/`dueDate`. Deadline TNP trống/thiếu tuân theo fallback đã xác nhận mà không đổi `registeredDate`; app-managed values được giữ nguyên. Không thêm chế độ “overwrite record” tổng quát.
- Phase 2 đã triển khai parser `.xlsx/.xls/.csv`, file picker, validate/preview/import/result và lịch sử import; không thêm mapping wizard khi alias đã biết.

### MOVED TO DETAIL

Giữ các năng lực và giá trị sau, nhưng không bắt chúng xuất hiện trong bảng chính hoặc Home:

- Field nguồn ít dùng: `no`, `writtenBy`, `supplier`, `vendorGroup`, `defectRate`, `sampleQty`, `defectQty`, `reason2`, `inspector`, `approver`, ngày approval/audit, cờ issue/claim/reoccurrence, `tatDays`, `tatCompliance`, `transactionType`, `locatedCorp`, các field PLM/vendor/initial-countermeasure và import extensions đã nhận diện khác.
- Chi tiết lỗi và provenance: `title`, `defectDetails`, `partCode`, `partName`, `partGroup`, `occurPlace`, `reason1`, project/model, source remarks. Chia nhóm hoặc dùng section thu gọn để màn hình đầu tập trung vào công việc.
- **PIC, Remark/notes và CA file link** là field quan trọng và phải dễ tìm trong Detail. Giữ chỉ báo PIC gọn trong Records; không lặp notes/đường dẫn dài trên từng row. `mqisCode` cũng được giữ khả năng sửa trong Detail như field quản lý legacy ít dùng.
- Status, deadline hiệu lực, completion date và các giá trị nguồn phục vụ đối chiếu/audit. Detail có thể hiện ngày đầy đủ và thông tin nguồn dù bảng chỉ dùng cặp TAT/deadline gọn.
- Import history/lỗi chi tiết, provenance và thao tác record ít dùng. Đặt thao tác phá hủy riêng, có chủ đích và yêu cầu xác nhận.

Chuyển field vào Detail chỉ là quyết định trình bày. Field vẫn phải có trong canonical model, storage và luồng import/export thích hợp.

### REMOVED

Bỏ hoặc không tái triển khai các cơ chế UI/legacy dư thừa dưới đây—không xóa dữ liệu nghiệp vụ hay năng lực record cần thiết:

- Cách triển khai monolithic `innerHTML`/global mutable state/re-render toàn bộ; parsing, status rules, date math, filter, sort hoặc persistence bị nhân bản theo từng màn hình.
- Bảng record thứ hai trên Home, bảng Rejected trùng lặp, hoặc table/drawer TAT/Corrective/Rejected độc lập. Dùng shared query/table/detail với cấu hình route.
- Grid 34 cột luôn mở, filter wall chiếm cả màn hình, import wizard nhiều bước khi mapping đã biết, badge status/TAT lặp lại, hoặc chart wall lấn át queue Records.
- Merge tổng quát mọi field import vào record đã tồn tại; âm thầm bỏ qua header lạ; reset/clear tự động; xóa record Completed tự động; thay ID hiện tại hoặc sửa `BASE_DATA`.
- Bắt buộc tải Google Fonts từ CDN, Windows `tnpopen://` registry/helper setup, hoặc installer/portable/executable/auto-updater. Giữ dữ liệu `caFileLink` và cách hiển thị/copy an toàn, chạy được trong development; không cam kết browser preview mở được tùy ý đường dẫn local.
- Login, account, cloud sync, notification server, AI, paid API, UI/chart/animation framework nặng, hệ thống theme hoặc feature creep khác.
- Selector CSS `.route-host` đã được xác minh không có JSX caller và được bỏ như dead style an toàn; không ảnh hưởng behavior hay data.

Không field dữ liệu hoặc business capability nào chưa rõ được phân loại để xóa. Nếu field nguồn không cần ở bảng chính, giữ trong Detail/source data và ghi nhận rõ.

### NOT REMOVED

- **Không xóa field hay record nguồn:** giữ đủ 191 seed record, 34 field gốc, ID, source text, recognized import extensions và field do người dùng quản lý. `BASE_DATA` tiếp tục read-only.
- **Không xóa năng lực xem Completed/Rejected:** Completed vẫn được lưu và truy cập qua lựa chọn view; Rejected vẫn là module riêng, giữ nguyên logic phân loại open/completed hiện tại.
- **Không bỏ workflow/data ít dùng:** PIC, Remark/notes, CA links, import history, source provenance, filters, analysis, corrective details và legacy fields đã nhận diện vẫn truy cập được dù chuyển khỏi bảng chính.
- **Không xóa capability legacy còn chưa rõ:** khi nghiệp vụ không rõ, giữ data/capability và đánh dấu hành vi `NEEDS CONFIRMATION` trước khi thay đổi.
- **Không quét bỏ code diện rộng:** business helpers có test và route placeholders được giữ đến khi màn hình thật thay thế. Cleanup duy nhất trong review này là CSS `.route-host` đã xác minh không dùng; không thay đổi nghiệp vụ hoặc dữ liệu.

## Đánh giá code, dependency và rủi ro legacy

### Ứng dụng React hiện tại

- Home đang hoạt động; Records, Analysis, TAT, Corrective và Rejected hiện là route placeholder. Đây là khoảng trống sản phẩm chính, không phải bằng chứng capability nghiệp vụ đã chết.
- Status, TAT, filters, KPI/date, duplicate matching, services và IndexedDB đã có module/test riêng. Page mới nên gọi lại các module này thay vì đưa business logic vào React component.
- `buildTnpSyncPatch` đã mã hóa whitelist đúng hai field. Import UI sau này phải gọi service flow hiện tại, không tự merge theo cách riêng.
- `headerMapping` là pure helper có test nhưng chưa nối với parser workbook/CSV thật. Khi triển khai parser hãy dùng helper này; không chép alias map vào component hoặc xóa nó vì hiện chưa có UI gọi.
- Một số helper filter/TAT/Corrective hiện chủ yếu được unit test sử dụng do page tương ứng vẫn là placeholder. Đây là nền tảng cho module dự kiến, không phải dead code.
- `PlannedPages`/`PlannedPage` vẫn được route sử dụng. Thay thế chúng khi từng màn hình thật được triển khai; không bỏ route trước khi destination có thật.
- Dependency hiện được giữ nhỏ: runtime gồm React, React DOM, React Router; dev/test gồm Vite, TypeScript, Vitest và `fake-indexeddb`. Chưa có UI/chart/animation framework lớn hay file parser. Không thêm dependency nếu chưa có nhu cầu được chứng minh; khi làm import, chỉ chọn parser tương thích offline nếu thực sự cần.
- Không cần broad cleanup/refactor trước Phase 2. Chỉ có dead CSS selector được xác minh là đã loại bỏ.

### Rủi ro legacy cần giữ rõ

- Legacy là một HTML/JS/CSS bundle lớn, global mutable state, thường xuyên rebuild DOM, lưu dữ liệu theo browser và có setup mở file phụ thuộc nền tảng. Giữ ý nghĩa nghiệp vụ, không giữ cách triển khai đó.
- Browser storage của legacy bị giới hạn theo origin; app development không thể đọc ngầm dữ liệu đó. Mọi migration runtime cần một snapshot export/import được review riêng và người dùng xác nhận. Không reset/overwrite bất kỳ store nào làm lối tắt.
- File opener legacy không thể mở đáng tin cậy mọi local path từ browser preview thông thường. Giữ field/giá trị; không port Windows registry helper nếu chưa có review riêng.
- Import legacy merge rộng các cột đã map. Đó **không** phải contract sync của app mới. Whitelist cho record hiện có vẫn chỉ là `status` và `dueDate`.
- TAT cũ dùng `registeredDate + 7`. Quy tắc người dùng hiện xác nhận đã thay thế hành vi đó khi `dueDate` hợp lệ. Không đưa logic legacy trở lại làm nguồn ưu tiên.

## NEEDS CONFIRMATION

Các câu hỏi dưới đây không cản trở review này; cần xử lý ở ranh giới workflow tương ứng trước khi xem ứng dụng là production-ready:

1. Xác nhận ý nghĩa vận hành của status legacy `Đợi duyệt` và `Đợi xét` nếu muốn thay đổi cách phân loại Completed hiện đang giữ. Cho tới khi có xác nhận, giữ phân loại đã được nguồn và code hiện tại hỗ trợ.
2. Xác nhận KPI “on-time closure” còn cần denominator legacy hay không: record có cả `completedDate` và `dueDate`, bất kể status hiện tại.
3. Chốt cách handoff tường minh, được duyệt cho dữ liệu thật đang ở IndexedDB/localStorage của origin legacy trước khi bật migration. App không được tự suy đoán hoặc truy cập ngầm.
4. Kiểm tra header/date format của file TNP thật. Parser hiện chặn chuỗi ngày dạng số mơ hồ (ví dụ `10/11/2026`) thay vì đoán thứ tự tháng/ngày; file `.xlsx/.xls` có date cell thật và chuỗi năm-trước như `YYYY-MM-DD` được hỗ trợ. Header `status` phải có và status từng dòng không được trống. Nếu mẫu TNP thực tế dùng định dạng/status khác, xác nhận mẫu cụ thể trước khi đổi validation. Mapping `dueDate` đã biết và quy tắc deadline hiện tại đã được xác nhận; không mở lại.
5. Với record thiếu Management Number, legacy fallback identity gồm `registeredDate`, plant, part code, title và defect quantity. Nếu nguồn có thể đổi `registeredDate` của các record này, cần xác nhận riêng trước khi thay identity rule; hiện không đồng bộ `registeredDate` trên record match.

## Checklist nghiệm thu Phase 2

- [x] Home gọn; KPI/plant signal mở Records với filter tương ứng; có nút Add TNP File và link/count Rejected.
- [x] Records là workspace chính, có cột gọn, filter thường dùng luôn thấy, More filters, Clear all và lựa chọn Active/All/Completed.
- [x] Completed vẫn lưu và xem được; Active là view mặc định; All sắp active trước, Completed phía dưới.
- [x] TAT/Corrective/Rejected dùng chung table/detail/business logic; Analysis dashboard vẫn để Phase 3.
- [x] Detail có PIC, Remark/notes, CA link, status/deadline và đầy đủ source data ít dùng.
- [x] Add TNP File có luồng select/validate/preview/import/result ngắn, history và whitelist sync hiện có.
- [x] Cửa sổ nhỏ vẫn có layout fallback; không đưa cloud, login, paid service, UI framework lớn hay installer phụ thuộc nền tảng vào phạm vi.
- [x] Test, typecheck, parser formats, persistence/import transaction và data-preservation checks đã chạy.

**Ranh giới phase:** Phase 2 đã triển khai theo phạm vi được phê duyệt. Analysis dashboard/Phase 3 không được bắt đầu trong lượt này.

## Phase 3 implementation addendum

Phase 2 scope above remains the approved foundation and is not reimplemented. Phase 3 replaces its explicitly deferred dashboard placeholders as follows:

- **One data/filter path:** Analysis, TAT, Corrective Actions and Rejected receive the same canonical records loaded through `RecordService`. Records and dashboards share `RecordFiltersPanel`, `RecordFilters` and `applyRecordFilters`; no dashboard database or stale cached record copy was added.
- **Analysis:** pure aggregations count the currently filtered repository records by registered month, Plant, Project/Model, reason, defect code and exact source status. Compact top-N CSS bars/month columns drill down to Records with URL filter parameters. The page does not read seed JSON directly or add a chart dependency.
- **TAT:** bucket counts use the existing effective deadline helper and exclude the exact Completed set. The buckets are overdue, due today, one day, two days, later and no deadline; overdue-by-Plant is the only breakdown. Clicking a bucket or Plant opens the shared Records table with those filters.
- **Corrective Actions:** only active records (including exact Rejected) enter the follow-up queue; operational effective-TAT ordering is reused. Missing-PIC / missing-CA-link scopes are compact list filters. PIC, Remark/Notes and CA File Link still save through the existing detail drawer and record service. Initial-countermeasure source fields remain canonical detail data and do not enter the TNP matched-record sync whitelist.
- **Rejected:** exact `Rejected (xét)` status is selected and sorted by the shared TAT urgency helper. Status edits/imports update the view from refreshed repository records; no duplicate rejected flag or table store exists.
- **Status/KPI boundary:** the current Completed set is unchanged. Analysis does not show a new on-time KPI because the legacy denominator and `Đợi duyệt` / `Đợi xét` semantics still need business confirmation.
- **Data/import safety:** `BASE_DATA`, IDs and the 34 original source fields are unchanged. Existing-record import sync remains exactly `status` and `dueDate`; no `registeredDate` sync or blank-`dueDate` behavior change was made. The blank matched-record import behavior remains an unresolved, documented question.

These are Phase 3 screens over the approved Phase 1/2 data and service foundation, not a separate data system. The Phase 2 boundary above remains historical: Analysis was not started during Phase 2; it is implemented in Phase 3.
