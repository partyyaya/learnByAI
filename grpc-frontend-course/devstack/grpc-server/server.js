const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const PROTO_PATH = path.join(__dirname, "ping.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});

const pingProto = grpc.loadPackageDefinition(packageDefinition).ping.v1;

function ping(call, callback) {
  const input = call.request.message || "ping";
  callback(null, {
    message: `pong: ${input}`,
    serverTimeUnixMs: Date.now(),
  });
}

function watch(call) {
  const input = call.request.message || "tick";
  const count = Math.max(1, call.request.count || 5);
  const intervalMs = Math.max(100, call.request.intervalMs || 1000);

  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    call.write({
      message: `${input} #${sent}`,
      serverTimeUnixMs: Date.now(),
    });

    if (sent >= count) {
      clearInterval(timer);
      call.end();
    }
  }, intervalMs);

  const stop = () => clearInterval(timer);
  call.on("cancelled", stop);
  call.on("error", stop);
  call.on("close", stop);
}

function main() {
  const server = new grpc.Server();

  server.addService(pingProto.PingService.service, {
    ping,
    watch,
  });

  const address = "0.0.0.0:50051";
  server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) {
      console.error("Failed to start gRPC server:", err);
      process.exit(1);
    }

    server.start();
    console.log(`gRPC server is listening on ${address}`);
  });
}

main();
