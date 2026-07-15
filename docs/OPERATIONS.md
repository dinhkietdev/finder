# Finder vận hành

## Cảnh báo API

API luôn ghi lỗi 5xx/429 vào bảng `api_alerts` của Supabase. Có thể gửi thêm
cảnh báo tới Discord, Slack hoặc webhook nội bộ bằng biến môi trường Vercel:

```env
FINDER_ALERT_WEBHOOK=https://example.invalid/finder-alerts
FINDER_ALERT_WEBHOOK_FORMAT=generic
```

`FINDER_ALERT_WEBHOOK_FORMAT` hỗ trợ `generic`, `discord` và `slack`.
Webhook được gửi nền, timeout 1,5 giây và retry một lần; lỗi webhook không làm
chậm request chính. Không đưa URL webhook vào frontend hoặc commit vào Git.

## Rate limit

Production ưu tiên RPC `consume_rate_limit` của Supabase; Upstash Redis là
phương án thay thế khi cần. API trả thêm các header:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `Retry-After` khi trả `429`

Theo dõi số lượng 429 và thời gian phản hồi trong log Vercel/Supabase trước khi
điều chỉnh ngưỡng.

## Guest album và upload

Trang khách nhận capability cookie `HttpOnly` theo từng album; các thao tác
chọn ảnh, ghi chú và xác nhận CHECK/FINAL không được chấp nhận nếu thiếu cookie
này. Cookie được cấp khi mở album hợp lệ và CORS production chỉ cho phép các
origin đã cấu hình.

Desktop đối chiếu tên, kích thước và MD5 trước khi upload. File mới được ghi
fingerprint vào `appProperties` của Google Drive để lần retry/resume sau không
tạo bản sao cùng nội dung.

## Dependency audit

`googleapis` đã được nâng có kiểm soát lên 173.x; audit desktop hiện sạch.
Root còn cảnh báo `uuid` mức moderate do `firebase-admin`/Google Cloud Storage
legacy kéo `uuid@9`. Không chạy `npm audit fix --force` vì npm sẽ đổi major
`firebase-admin` và có thể phá fallback đang dùng trong quá trình chuyển đổi.
Khi bỏ hoàn toàn Firebase fallback, có thể gỡ `firebase-admin`; khi đó audit
sẽ được chạy lại và xử lý dứt điểm dependency này.
