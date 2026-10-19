# E-commerce MVP — Microservices

Backend RESTful API cho hệ thống thương mại điện tử MVP, xây dựng bằng Node.js theo kiến trúc Microservices, DDD và Database-per-Service.

## 1. Chức năng

- Đăng ký tài khoản, đăng nhập và cấp JWT.
- Xác thực và phân quyền CUSTOMER, ADMIN, SHIPMENT_STAFF.
- Xem và cập nhật hồ sơ khách hàng.
- Gán hạng thành viên cho khách hàng theo quyền Admin.
- Đọc score của hạng thành viên để tính giảm giá.
- Quản lý sản phẩm và tồn kho.
- Đặt hàng, tính tiền và lưu Order/OrderDetail.
- Chống tạo đơn hoặc trừ kho trùng khi gửi lại yêu cầu.
- Phát sự kiện OrderCreated qua Transactional Outbox và Kafka.
- Tự động tạo Shipment và cập nhật trạng thái giao hàng.
- Redis cache thông tin xác thực và rate limiting tại Gateway.
- Logging, liveness và readiness.
- Chạy local bằng Docker Compose.

## 2. Công nghệ và kiến trúc

| Thành phần | Công nghệ |
|---|---|
| API Gateway | Node.js, Express, Redis |
| Auth Service | Node.js, gRPC, PostgreSQL, bcrypt, JWT |
| Customer Service | Node.js, gRPC, PostgreSQL |
| Product Service | Node.js, gRPC, MongoDB, Mongoose |
| Order Service | Node.js, gRPC, PostgreSQL, KafkaJS, decimal.js |
| Shipment Service | Node.js, gRPC, MongoDB, KafkaJS |
| Event broker | Apache Kafka |
| Container | Docker, Docker Compose |

Client gọi REST API qua Gateway. Gateway gọi các service bằng gRPC.

Mỗi service sở hữu database riêng. Các service không truy cập trực tiếp database của nhau trong luồng nghiệp vụ.

Order Service lưu Order, OrderDetail và OutboxEvent trong cùng transaction PostgreSQL. Khi việc đặt hàng hoàn tất, Outbox publisher gửi OrderCreated tới Kafka. Shipment Service nhận sự kiện và tạo phiếu giao hàng.

Trong từng service, source được tổ chức thành các lớp:

- `domain`: quy tắc và đối tượng nghiệp vụ.
- `application`: các use case.
- `infrastructure`: database, repository và client giao tiếp.
- `interfaces`: gRPC handlers.

## 3. Cấu trúc dự án

| Đường dẫn | Nội dung |
|---|---|
| `api-gateway/` | REST routes, middleware, Redis và gRPC clients |
| `services/auth-service/` | Tài khoản, đăng nhập và JWT |
| `services/customer-service/` | Hồ sơ khách hàng và membership |
| `services/product-service/` | Sản phẩm và inventory |
| `services/order-service/` | Đơn hàng, pricing, recovery và Outbox |
| `services/shipment-service/` | Shipment và Kafka consumer |
| `proto/` | Các gRPC contract |
| `shared/` | Thành phần dùng chung cho health check |
| `Dockerfile` | Dockerfile dùng chung, chọn ứng dụng bằng APP_PATH |
| `docker-compose.yml` | PostgreSQL, MongoDB, Redis và Kafka |
| `docker-compose.override.yml` | Sáu ứng dụng và năm service khởi tạo |

## 4. Yêu cầu môi trường

- Git.
- Docker Desktop chạy Linux containers.
- Docker Compose hỗ trợ `up --wait`.
- Internet cho lần tải image và cài dependencies đầu tiên.
- Node.js 24 và npm nếu chạy các script kiểm tra trên máy.

Các cổng local cần được giải phóng trước khi khởi động:

`3000`, `5433`, `5434`, `5435`, `27018`, `27019`, `6380`, `9092`.

## 5. Clone repository

```powershell
git clone https://github.com/Doanquocthai2104/ecommerce-microservices-mvp.git

cd ecommerce-microservices-mvp
```

## 6. Chuẩn bị cấu hình môi trường

Mỗi ứng dụng có một `.env.example`.

Chạy đoạn PowerShell sau tại thư mục gốc. Lệnh chỉ tạo `.env` nếu file chưa tồn tại:

```powershell
$apps = @(
  "api-gateway",
  "services/auth-service",
  "services/customer-service",
  "services/product-service",
  "services/order-service",
  "services/shipment-service"
)

foreach ($app in $apps) {
  if (-not (Test-Path "$app/.env")) {
    Copy-Item "$app/.env.example" "$app/.env"
    Write-Host "Created $app/.env"
  } else {
    Write-Host "Preserved existing $app/.env"
  }
}
```

Thay các giá trị placeholder:

1. Trong `services/auth-service/.env`, đặt JWT_SECRET bằng một secret ngẫu nhiên có ít nhất 32 ký tự.
2. Tạo một service key ngẫu nhiên khác.
3. Đặt cùng service key đó vào ORDER_SERVICE_KEY của Product Service và Order Service.

Nếu có Node.js, có thể chạy lệnh sau để sinh một secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Chạy hai lần để có hai giá trị riêng: một JWT secret và một service key.

Các tài khoản PostgreSQL trong Compose là cấu hình cho môi trường local của bài tập.

Không commit file `.env` hoặc secret thật lên GitHub.

Compose đọc `.env` của từng ứng dụng, sau đó ghi đè địa chỉ kết nối bằng tên service trong mạng Docker.

## 7. Build và khởi động

Chạy Docker Desktop, sau đó chạy tại thư mục gốc:

```powershell
docker compose config --quiet

docker compose build
```

Nếu build thành công:

```powershell
docker compose up -d --wait --wait-timeout 360 api-gateway
```

Gateway kéo theo toàn bộ dependency cần thiết.

Hệ thống tự thực hiện:

- Khởi tạo bảng và role trong Auth database.
- Khởi tạo Customer database và seed membership.
- Khởi tạo Order, OrderDetail, OutboxEvent và OrderRequest.
- Khởi tạo Product replica set `product-rs` nếu chưa có.
- Tạo Kafka topic `order-created` nếu chưa có.
- Khởi động sáu ứng dụng.

Không cần mở riêng các server bằng `node src/server.js` khi đang chạy bằng Docker.

## 8. Kiểm tra container

```powershell
docker compose ps -a
```

Kết quả mong đợi:

- 13 container chạy lâu dài ở trạng thái healthy.
- Năm container khởi tạo ở trạng thái Exited (0).

Các container khởi tạo:

- auth-init
- customer-init
- order-init
- product-db-init
- kafka-init

Exited (0) nghĩa là script khởi tạo đã hoàn thành thành công.

## 9. Kiểm tra sức khỏe

Gateway REST API:

`http://127.0.0.1:3000`

Kiểm tra liveness:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/live
```

Kiểm tra readiness tổng hợp:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health |
  ConvertTo-Json -Depth 5
```

Kết quả bình thường:

- HTTP 200.
- `status` là `UP`.
- Gateway, Redis và năm service đều `UP`.

Khi một dependency bắt buộc không sẵn sàng, readiness trả HTTP 503. Liveness vẫn phản ánh tiến trình Gateway còn hoạt động.

Có thể chạy script kiểm tra trên máy sau khi cài dependencies của Gateway:

```powershell
npm ci --prefix api-gateway

node api-gateway/scripts/check-health.js
```

## 10. REST API

| Method | Endpoint | Quyền |
|---|---|---|
| POST | `/api/auth/register` | Không cần JWT |
| POST | `/api/auth/login` | Không cần JWT |
| GET | `/api/customers/:uid` | Customer sở hữu hồ sơ hoặc Admin |
| PUT | `/api/customers/:uid` | Customer sửa tên của mình; Admin có thể gán membership |
| GET | `/api/products` | Có JWT |
| GET | `/api/products/:pid` | Có JWT |
| POST | `/api/products` | Admin |
| PUT | `/api/products/:pid` | Admin |
| DELETE | `/api/products/:pid` | Admin |
| POST | `/api/orders` | Customer |
| GET | `/api/orders` | Customer/Admin, lấy danh sách của tài khoản hiện tại |
| GET | `/api/orders/:oid` | Customer sở hữu đơn hoặc Admin |
| GET | `/api/shipments/:shipid` | Customer sở hữu Shipment, Admin hoặc Shipment Staff |
| PATCH | `/api/shipments/:shipid/status` | Admin hoặc Shipment Staff |
| GET | `/api/health` | Không cần JWT |

Endpoint bổ sung `/api/live` dùng để kiểm tra liveness.

Các API cần xác thực sử dụng header:

```http
Authorization: Bearer <accessToken>
```

Đăng ký công khai luôn tạo tài khoản CUSTOMER. API đăng ký không cho người dùng tự chọn quyền Admin hoặc Shipment Staff.

## 11. Đặt hàng và idempotency

POST `/api/orders` yêu cầu:

```http
Authorization: Bearer <accessToken>
Idempotency-Key: <UUID>
Content-Type: application/json
```

Request body:

```json
{
  "items": [
    {
      "pid": 1,
      "qty": 2
    }
  ]
}
```

- Client gửi PID và số lượng.
- Backend lấy UID từ danh tính đã xác thực.
- Backend lấy giá từ Product và score từ Customer.
- Client không được tự gửi UID, đơn giá hoặc discount.
- Gửi lại cùng key và cùng sản phẩm trả về đơn hàng đã tạo.
- Dùng lại key với nội dung khác bị từ chối.
- Các thao tác inventory có cơ chế chống xử lý trùng.

Shipment được tạo bất đồng bộ qua Kafka. Nếu chưa có Shipment trong thời gian Gateway chờ, trường `shipment` có thể là `null`. Client có thể đọc lại chi tiết đơn hàng sau đó.

## 12. Membership và discount

Cấu hình mẫu:

| Membership | Score | Discount |
|---|---:|---:|
| BASIC | 0 | 0% |
| SILVER | 100 | 5% |
| GOLD | 500 | 10% |
| PLATINUM | 1000 | 15% |

Các mức trên là cấu hình MVP của dự án.

- Membership được seed trong Customer database.
- Discount tiers được cấu hình bằng DISCOUNT_TIERS của Order Service.
- Customer không tự sửa membership hoặc score.
- Admin có thể gán membership đã tồn tại.
- Score hiện được đọc từ membership, chưa có cơ chế tự tích điểm theo đơn hàng.
- Đơn hàng đã lưu giữ nguyên số tiền khi membership thay đổi.

## 13. Trạng thái Shipment

Các chuyển trạng thái được hỗ trợ:

- PENDING sang SHIPPING hoặc CANCELLED.
- SHIPPING sang DELIVERED hoặc CANCELLED.
- DELIVERED và CANCELLED là trạng thái kết thúc.
- Cập nhật lại cùng trạng thái trả về trạng thái hiện có.

CANCELLED ở đây là trạng thái giao hàng. Chức năng này không thực hiện hủy Order hoặc hoàn lại tồn kho của đơn đã hoàn tất.

## 14. Cổng kết nối local

| Thành phần | Địa chỉ trên máy |
|---|---|
| Gateway | `127.0.0.1:3000` |
| Auth PostgreSQL | `127.0.0.1:5433` |
| Customer PostgreSQL | `127.0.0.1:5434` |
| Order PostgreSQL | `127.0.0.1:5435` |
| Product MongoDB | `127.0.0.1:27018` |
| Shipment MongoDB | `127.0.0.1:27019` |
| Redis | `127.0.0.1:6380` |
| Kafka external listener | `127.0.0.1:9092` |

Các service gRPC dùng cổng 50051–50055 trong mạng Docker và không publish ra máy.

Script gRPC muốn chạy từ máy cần cấu hình publish cổng riêng hoặc chạy trong container với địa chỉ phù hợp.

## 15. Xem log và xử lý lỗi

```powershell
docker compose logs --tail 100 api-gateway

docker compose logs --tail 100 order-service shipment-service

docker compose logs --tail 100 auth-init customer-init order-init product-db-init kafka-init
```

Nếu Gateway không khởi động:

1. Kiểm tra cổng 3000 có đang bị server Node khác sử dụng.
2. Kiểm tra `.env` của sáu ứng dụng đã tồn tại.
3. Kiểm tra JWT_SECRET và ORDER_SERVICE_KEY đã được cấu hình.
4. Kiểm tra năm init có kết thúc mã 0.
5. Xem log service đang unhealthy.

Kafka và Shipment consumer có thể cần thêm thời gian kết nối hoặc tham gia lại consumer group sau khi Kafka khởi động lại.

## 16. Dừng và chạy lại

Tạm dừng:

```powershell
docker compose stop
```

Chạy lại:

```powershell
docker compose up -d --wait --wait-timeout 360 api-gateway
```

Gỡ container và network, giữ named volume:

```powershell
docker compose down
```

Dữ liệu database nằm trong named volume. Tùy chọn `down -v` xóa các volume của project, vì vậy không dùng nếu muốn giữ dữ liệu.

## 17. Cập nhật source

Sau khi thay đổi source, build và chạy lại:

```powershell
docker compose build

docker compose up -d --wait --wait-timeout 360 api-gateway
```

## 18. Phạm vi kiểm tra đã thực hiện

- Kiểm tra repository, application service, gRPC và REST theo từng chức năng.
- Kiểm tra JWT và quyền truy cập.
- Kiểm tra inventory transaction, chống oversell và idempotency.
- Kiểm tra Outbox, Kafka consumer và event trùng.
- Kiểm tra luồng đặt hàng đến tạo Shipment trên Docker.
- Kiểm tra discount của các membership.
- Kiểm tra health khi database, Redis hoặc Kafka dừng và phục hồi.
- Kiểm tra khởi tạo hệ thống trên volume trống bằng Compose project riêng.

Bảng đối chiếu nghiệm thu theo 25 test case của tài liệu thiết kế được tổng hợp riêng.