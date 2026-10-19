# E-commerce MVP — Microservices

Backend RESTful API cho hệ thống thương mại điện tử MVP, sử dụng Node.js theo kiến trúc Microservices, Domain-Driven Design (DDD) và Database-per-Service.

## 1. Chức năng

- Đăng ký tài khoản và đăng nhập.
- Xác thực JWT và phân quyền theo vai trò.
- Xem và cập nhật thông tin khách hàng.
- Quản lý hạng thành viên và đọc score tương ứng.
- Quản lý sản phẩm và tồn kho.
- Đặt hàng, tính discount theo score.
- Lưu Order và OrderDetail.
- Chuyển thông tin đơn hàng sang Shipment qua Kafka.
- Xem và cập nhật trạng thái giao hàng.
- Redis cache và rate limiting tại API Gateway.
- Logging và health check.
- Dockerize và chạy local bằng Docker Compose.

## 2. Công nghệ

| Thành phần | Công nghệ |
|---|---|
| Backend | Node.js 24 |
| REST API Gateway | Express |
| Giao tiếp đồng bộ | gRPC |
| Giao tiếp bất đồng bộ | Apache Kafka |
| Auth, Customer, Order database | PostgreSQL |
| Product, Shipment database | MongoDB, Mongoose |
| Cache và rate limiting | Redis |
| Xác thực | JWT, bcrypt |
| Tính toán tiền | decimal.js |
| Container | Docker, Docker Compose |

## 3. Kiến trúc

Hệ thống gồm API Gateway và năm microservice:

| Service | Trách nhiệm | Database |
|---|---|---|
| API Gateway | Routing, xác thực, phân quyền, JWT validation, rate limiting và logging | Redis |
| Auth Service | Tài khoản, đăng nhập và JWT | PostgreSQL riêng |
| Customer Service | Hồ sơ khách hàng, membership và score | PostgreSQL riêng |
| Product Service | Sản phẩm, tồn kho và inventory reservation | MongoDB riêng |
| Order Service | Đặt hàng, discount, OrderDetail và Outbox | PostgreSQL riêng |
| Shipment Service | Nhận OrderCreated và quản lý giao hàng | MongoDB riêng |

Client gọi REST API qua Gateway. Gateway giao tiếp với các service bằng gRPC.

Mỗi microservice sở hữu database riêng. Trong luồng nghiệp vụ, các service trao đổi qua API hoặc sự kiện, không truy cập trực tiếp database của nhau.

Source trong từng service được chia thành bốn lớp:

- `domain`: quy tắc nghiệp vụ.
- `application`: các use case.
- `infrastructure`: database, repository và communication clients.
- `interfaces`: gRPC handlers.

## 4. Cấu trúc dự án

| Đường dẫn | Nội dung |
|---|---|
| `api-gateway/` | REST routes, middleware và gRPC clients |
| `services/auth-service/` | Tài khoản và xác thực |
| `services/customer-service/` | Khách hàng và membership |
| `services/product-service/` | Sản phẩm và tồn kho |
| `services/order-service/` | Đơn hàng, pricing, recovery và Outbox |
| `services/shipment-service/` | Shipment và Kafka consumer |
| `proto/` | Các gRPC contract |
| `shared/` | Thành phần health check dùng chung |
| `Dockerfile` | Dockerfile dùng chung cho sáu ứng dụng |
| `docker-compose.yml` | Database, Redis và Kafka |
| `docker-compose.override.yml` | Các ứng dụng và service khởi tạo |

## 5. Yêu cầu môi trường

- Git.
- Docker Desktop chạy Linux containers.
- Docker Compose hỗ trợ `up --wait`.
- Internet cho lần tải image và cài dependencies đầu tiên.
- Node.js 24 và npm nếu chạy script kiểm tra trực tiếp trên máy.

Các cổng local được sử dụng:

`3000`, `5433`, `5434`, `5435`, `27018`, `27019`, `6380`, `9092`.

## 6. Clone repository

```powershell
git clone https://github.com/Doanquocthai2104/ecommerce-microservices-mvp.git

cd ecommerce-microservices-mvp
```

## 7. Cấu hình môi trường

Tạo sáu file `.env` tại các vị trí bên dưới.

Các file này được Git bỏ qua. Người clone repository cần tự tạo chúng trước khi chạy Docker Compose.

### 7.1. API Gateway

File: `api-gateway/.env`

```dotenv
HOST=127.0.0.1
PORT=3000

AUTH_GRPC_URL=127.0.0.1:50051
CUSTOMER_GRPC_URL=127.0.0.1:50052
PRODUCT_GRPC_URL=127.0.0.1:50053
ORDER_GRPC_URL=127.0.0.1:50054
SHIPMENT_GRPC_URL=127.0.0.1:50055

REDIS_URL=redis://127.0.0.1:6380
```

### 7.2. Auth Service

File: `services/auth-service/.env`

```dotenv
DATABASE_URL=postgresql://auth_user:auth_pass_local@127.0.0.1:5433/auth_db

GRPC_HOST=127.0.0.1
GRPC_PORT=50051

JWT_SECRET=REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
```

Thay JWT_SECRET bằng secret ngẫu nhiên có ít nhất 32 ký tự.

### 7.3. Customer Service

File: `services/customer-service/.env`

```dotenv
DATABASE_URL=postgresql://customer_user:customer_pass_local@127.0.0.1:5434/customer_db

GRPC_HOST=127.0.0.1
GRPC_PORT=50052

AUTH_GRPC_URL=127.0.0.1:50051
```

### 7.4. Product Service

File: `services/product-service/.env`

```dotenv
MONGO_URI=mongodb://127.0.0.1:27018/product_db?replicaSet=product-rs&directConnection=true

GRPC_HOST=127.0.0.1
GRPC_PORT=50053

AUTH_GRPC_URL=127.0.0.1:50051

ORDER_SERVICE_KEY=REPLACE_WITH_A_RANDOM_SERVICE_KEY_AT_LEAST_32_CHARACTERS
```

### 7.5. Order Service

File: `services/order-service/.env`

```dotenv
DATABASE_URL=postgresql://order_user:order_pass_local@127.0.0.1:5435/order_db

GRPC_HOST=127.0.0.1
GRPC_PORT=50054

AUTH_GRPC_URL=127.0.0.1:50051
CUSTOMER_GRPC_URL=127.0.0.1:50052
PRODUCT_GRPC_URL=127.0.0.1:50053

ORDER_SERVICE_KEY=REPLACE_WITH_A_RANDOM_SERVICE_KEY_AT_LEAST_32_CHARACTERS

DISCOUNT_TIERS='[{"minScore":0,"percent":0},{"minScore":100,"percent":5},{"minScore":500,"percent":10},{"minScore":1000,"percent":15}]'

KAFKA_BROKERS=127.0.0.1:9092
KAFKA_CLIENT_ID=order-service
```

ORDER_SERVICE_KEY của Product Service và Order Service phải giống nhau.

Giữ DISCOUNT_TIERS trên một dòng trong file.

### 7.6. Shipment Service

File: `services/shipment-service/.env`

```dotenv
MONGO_URI=mongodb://127.0.0.1:27019/shipment_db

GRPC_HOST=127.0.0.1
GRPC_PORT=50055

AUTH_GRPC_URL=127.0.0.1:50051

KAFKA_BROKERS=127.0.0.1:9092
KAFKA_CLIENT_ID=shipment-service
KAFKA_GROUP_ID=shipment-service-v1
```

### 7.7. Sinh secret

Nếu máy có Node.js, chạy:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Chạy hai lần để tạo:

1. Một giá trị cho JWT_SECRET.
2. Một giá trị khác dùng chung cho ORDER_SERVICE_KEY của Product và Order.

Không sử dụng nguyên giá trị placeholder và không commit secret thật lên GitHub.

Địa chỉ `127.0.0.1` trong các file trên phục vụ chạy Node trực tiếp trên máy. Khi chạy Docker, Compose ghi đè bằng tên service trong mạng container.

Tài khoản PostgreSQL trong Compose là cấu hình dành cho môi trường local của bài tập.

## 8. Build và khởi động

Mở Docker Desktop và chạy tại thư mục gốc:

```powershell
docker compose config --quiet
```

Build image:

```powershell
docker compose build
```

Sau khi build thành công:

```powershell
docker compose up -d --wait --wait-timeout 360 api-gateway
```

Gateway kéo theo các dependency đã khai báo.

Hệ thống tự động:

- Khởi tạo Auth database và seed ba role.
- Khởi tạo Customer database và seed membership.
- Khởi tạo Order, OrderDetail, OutboxEvent và OrderRequest.
- Khởi tạo MongoDB replica set `product-rs` nếu chưa có.
- Tạo Kafka topic `order-created` nếu chưa có.
- Khởi động sáu ứng dụng.

Không cần chạy riêng `node src/server.js` khi hệ thống đang chạy bằng Docker.

## 9. Kiểm tra trạng thái

```powershell
docker compose ps -a
```

Kết quả mong đợi:

- 13 container chạy lâu dài ở trạng thái `healthy`.
- Năm container khởi tạo ở trạng thái `Exited (0)`.

Năm container khởi tạo gồm:

- `auth-init`
- `customer-init`
- `order-init`
- `product-db-init`
- `kafka-init`

`Exited (0)` nghĩa là tác vụ khởi tạo đã hoàn thành thành công.

## 10. Health check

Gateway chạy tại:

`http://127.0.0.1:3000`

### Liveness

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/live
```

### Readiness tổng hợp

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health |
  ConvertTo-Json -Depth 5
```

Khi hệ thống sẵn sàng:

- HTTP status là `200`.
- `status` là `UP`.
- Gateway, Redis và năm service đều `UP`.

Khi dependency bắt buộc không sẵn sàng, readiness trả `503`. Liveness vẫn phản ánh tiến trình Gateway còn hoạt động.

Có thể chạy script kiểm tra trên máy:

```powershell
npm ci --prefix api-gateway

node api-gateway/scripts/check-health.js
```

## 11. REST API

| Method | Endpoint | Quyền truy cập |
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
| GET | `/api/orders` | Customer/Admin, lấy đơn của tài khoản hiện tại |
| GET | `/api/orders/:oid` | Customer sở hữu đơn hoặc Admin |
| GET | `/api/shipments/:shipid` | Customer sở hữu Shipment, Admin hoặc Shipment Staff |
| PATCH | `/api/shipments/:shipid/status` | Admin hoặc Shipment Staff |
| GET | `/api/health` | Không cần JWT |

Endpoint bổ sung `/api/live` dùng để kiểm tra liveness.

API cần xác thực sử dụng header:

```http
Authorization: Bearer <accessToken>
```

Đăng ký công khai luôn tạo tài khoản CUSTOMER. Người dùng không được tự chọn role Admin hoặc Shipment Staff qua API đăng ký.

## 12. Luồng đặt hàng

1. Customer gửi JWT, Idempotency-Key và danh sách sản phẩm.
2. Backend xác định UID từ danh tính đã xác thực.
3. Order Service đọc membership score từ Customer Service.
4. Product Service giữ tồn kho và trả về giá sản phẩm tại thời điểm đặt hàng.
5. Order Service tính subtotal, discount và total.
6. Order, OrderDetail, OutboxEvent và trạng thái request được lưu trong cùng transaction PostgreSQL.
7. Inventory được commit và request hoàn tất.
8. Outbox publisher gửi OrderCreated tới Kafka.
9. Shipment consumer nhận sự kiện và tạo Shipment PENDING.

Request mẫu:

```http
POST /api/orders
Authorization: Bearer <accessToken>
Idempotency-Key: <UUID>
Content-Type: application/json
```

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

Client gửi PID và số lượng. UID, đơn giá và discount được xác định ở backend.

### Idempotency

- Gửi lại cùng key và cùng nội dung trả về đơn đã tạo.
- Dùng lại key với nội dung khác bị từ chối.
- Gửi lại yêu cầu không trừ kho hoặc tạo Shipment lần nữa.
- Shipment xử lý sự kiện trùng mà không tạo thêm phiếu giao hàng.

Shipment được tạo bất đồng bộ. Nếu chưa có Shipment trong thời gian Gateway chờ, trường `shipment` có thể là `null`. Client có thể đọc lại chi tiết đơn hàng sau đó.

## 13. Membership và discount

Cấu hình MVP hiện tại:

| Membership | Score | Discount |
|---|---:|---:|
| BASIC | 0 | 0% |
| SILVER | 100 | 5% |
| GOLD | 500 | 10% |
| PLATINUM | 1000 | 15% |

- Customer mới nhận membership BASIC.
- Admin có thể gán membership đã tồn tại.
- Customer không tự sửa membership hoặc score.
- Score được đọc từ membership, chưa có chức năng tự tích điểm theo đơn hàng.
- Discount được tính theo DISCOUNT_TIERS của Order Service.
- Tiền sử dụng decimal.js và làm tròn HALF_UP tới hai chữ số thập phân.
- Đơn hàng đã lưu giữ nguyên số tiền khi membership thay đổi.

## 14. Trạng thái Shipment

Các trạng thái:

- `PENDING`
- `SHIPPING`
- `DELIVERED`
- `CANCELLED`

Quy tắc chuyển trạng thái:

- PENDING → SHIPPING hoặc CANCELLED.
- SHIPPING → DELIVERED hoặc CANCELLED.
- DELIVERED và CANCELLED là trạng thái kết thúc.
- Cập nhật lại cùng trạng thái trả về trạng thái hiện có.

Chỉ Admin hoặc Shipment Staff được cập nhật trạng thái.

CANCELLED là trạng thái giao hàng. Chức năng này không hủy Order hoặc hoàn lại tồn kho của đơn đã hoàn tất.

## 15. Cổng kết nối local

| Thành phần | Địa chỉ |
|---|---|
| API Gateway | `127.0.0.1:3000` |
| Auth PostgreSQL | `127.0.0.1:5433` |
| Customer PostgreSQL | `127.0.0.1:5434` |
| Order PostgreSQL | `127.0.0.1:5435` |
| Product MongoDB | `127.0.0.1:27018` |
| Shipment MongoDB | `127.0.0.1:27019` |
| Redis | `127.0.0.1:6380` |
| Kafka external listener | `127.0.0.1:9092` |

Các service gRPC dùng cổng 50051–50055 trong mạng Docker, không publish ra máy.

Script kiểm tra gRPC chạy từ máy cần cấu hình publish cổng riêng hoặc chạy trong container với địa chỉ phù hợp.

## 16. Xem log

```powershell
docker compose logs --tail 100 api-gateway
```

```powershell
docker compose logs --tail 100 order-service shipment-service
```

```powershell
docker compose logs --tail 100 auth-init customer-init order-init product-db-init kafka-init
```

Khi có lỗi khởi động:

1. Kiểm tra đủ sáu file `.env`.
2. Kiểm tra JWT_SECRET và ORDER_SERVICE_KEY.
3. Kiểm tra cổng local có bị chương trình khác sử dụng.
4. Kiểm tra năm init có kết thúc mã 0.
5. Đọc log service đang unhealthy.

Sau khi Kafka khởi động lại, Shipment consumer có thể cần thêm thời gian tham gia lại consumer group trước khi readiness trở về UP.

## 17. Dừng và chạy lại

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

Dữ liệu nằm trong named volume. Không dùng `docker compose down -v` nếu muốn giữ dữ liệu.

## 18. Cập nhật sau khi sửa source

```powershell
docker compose build
```

```powershell
docker compose up -d --wait --wait-timeout 360 api-gateway
```

## 19. Kiểm tra đã thực hiện

Các kết quả kiểm tra trong quá trình xây dựng gồm:

- Đăng ký, đăng nhập, JWT và phân quyền.
- Customer, membership và discount.
- Product CRUD và inventory transaction.
- Chống oversell, xử lý đồng thời và idempotency.
- Order transaction, recovery và Outbox.
- Kafka producer/consumer và xử lý event trùng hoặc không hợp lệ.
- Shipment gRPC và REST API.
- Luồng đặt hàng đến tạo Shipment trên Docker.
- Health check khi dependency dừng và phục hồi.
- Khởi tạo tự động bằng Compose project riêng với volume trống.

Bảng đối chiếu nghiệm thu theo 25 test case của tài liệu thiết kế chưa được tổng hợp trong repository.