// A minimal WebSocket server that speaks enough of the protocol to stand in for
// the INDstocks price feed.
//
// Node ships a WebSocket *client* but no server, and pulling in `ws` purely for
// tests would put a dependency in the tree that the shipped code does not use.
// The framing below is the small subset needed: text frames, close frames, and
// client-side unmasking.

import http from "node:http";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload, "utf8");
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

/** Pull whole frames out of a buffer, returning whatever tail is incomplete. */
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > buffer.length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

/**
 * Start a fake feed. `rejectWith` makes the handshake fail with that HTTP status,
 * which is how a bad token presents.
 */
export async function startFakeFeed({ rejectWith = null } = {}) {
  const events = new EventEmitter();
  const connections = [];
  const server = http.createServer();

  server.on("upgrade", (req, socket) => {
    if (rejectWith) {
      socket.end(`HTTP/1.1 ${rejectWith} Unauthorized\r\n\r\n`);
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(req.headers["sec-websocket-key"] + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const connection = { socket, headers: req.headers, messages: [] };
    connections.push(connection);
    events.emit("connection", connection);

    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const { frames, rest } = decodeFrames(buffered);
      buffered = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.end();
          continue;
        }
        if (frame.opcode === 0x1) {
          const text = frame.payload.toString("utf8");
          connection.messages.push(JSON.parse(text));
          events.emit("message", JSON.parse(text), connection);
        }
      }
    });
    socket.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const live = () => connections.filter((c) => !c.socket.destroyed);

  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    events,
    connections,
    live,
    /** Push a tick to every open connection. */
    push(message) {
      const frame = encodeFrame(JSON.stringify(message));
      for (const connection of live()) connection.socket.write(frame);
    },
    /** Push a raw non-JSON frame, i.e. what a heartbeat looks like. */
    pushRaw(text) {
      const frame = encodeFrame(text);
      for (const connection of live()) connection.socket.write(frame);
    },
    /** Server-initiated close with a status code. */
    closeWith(code) {
      const frame = Buffer.alloc(4);
      frame[0] = 0x88;
      frame[1] = 0x02;
      frame.writeUInt16BE(code, 2);
      for (const connection of live()) connection.socket.write(frame);
    },
    /** Yank the connection without a close frame, like a network drop. */
    dropAll() {
      for (const connection of live()) connection.socket.destroy();
    },
    async stop() {
      for (const connection of connections) {
        try {
          connection.socket.destroy();
        } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Poll until `predicate` is true, or throw. Keeps the tests free of fixed sleeps. */
export async function waitFor(predicate, { timeoutMs = 4000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
