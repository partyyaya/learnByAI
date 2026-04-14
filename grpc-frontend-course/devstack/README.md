# gRPC Frontend Course Dev Stack

這個資料夾提供 `compose.yaml` 會用到的示範服務與設定：

- `grpc-server`：Node.js gRPC server（`PingService`）
- `envoy`：gRPC-Web proxy
- `frontend`：Vite 前端示範頁

## 啟動

```bash
cd grpc-frontend-course
docker compose up -d --build
```

## 服務位址

- gRPC server: `localhost:50051`
- gRPC-Web proxy: `http://localhost:8080`
- Envoy admin: `http://localhost:9901`
- Frontend demo: `http://localhost:5173`

## 驗證

你可以使用 `grpcurl` 直接打 gRPC server（非 gRPC-Web）：

```bash
grpcurl -plaintext -d '{"message":"hello"}' \
  localhost:50051 ping.v1.PingService/Ping
```

預期回傳（示意）：

```json
{
  "message": "pong: hello",
  "serverTimeUnixMs": "1713170000000"
}
```
