# ===== 階段 1：建構 =====
FROM golang:1.27-alpine AS builder

WORKDIR /app
# go.* 會同時比對 go.mod 與 go.sum；沒有外部套件的專案沒有 go.sum，寫死 go.sum 會 COPY 失敗
COPY go.* ./
RUN go mod download
COPY . .
# CGO_ENABLED=0：產生不依賴 C 函式庫的靜態執行檔，才能放進什麼都沒有的 scratch
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .

# ===== 階段 2：最終映像 =====
FROM scratch

COPY --from=builder /app/server /server
# scratch 裡沒有 CA 憑證，程式若要呼叫 HTTPS API 必須自己帶進來
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# scratch 沒有 /etc/passwd，不能用使用者名稱，直接寫數字 UID:GID（65534 慣例上是 nobody）
USER 65534:65534

EXPOSE 8080
ENTRYPOINT ["/server"]
