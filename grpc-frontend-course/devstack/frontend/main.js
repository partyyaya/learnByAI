const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

const app = document.querySelector("#app");

app.innerHTML = `
  <main style="font-family: Arial, sans-serif; max-width: 760px; margin: 32px auto; line-height: 1.7;">
    <h1>Frontend gRPC 課程示範環境</h1>
    <p>前端開發伺服器已啟動。</p>
    <ul>
      <li>gRPC server: <code>localhost:50051</code></li>
      <li>gRPC-Web proxy (Envoy): <code>${apiBaseUrl}</code></li>
      <li>Envoy admin: <code>http://localhost:9901</code></li>
    </ul>
    <p>你可以在自己的專案中設定：</p>
    <pre style="background:#f6f8fa;padding:12px;border-radius:8px;">VITE_API_BASE_URL=${apiBaseUrl}</pre>
  </main>
`;
