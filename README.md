# http-streamify

> Extracted from [openai-node](https://github.com/openai/openai-node)

http-streamify is a library for creating and handling streams, especially for Server-Sent Events (SSE) and newline-delimited JSON streams.

http-streamify 是一个用于处理 Server-Sent Events (SSE) 和可读流的 JavaScript 库。该库适用于在浏览器和 Node.js 环境中使用。

## Installation

You can install the package using npm:

导入 http-streamify

```bash
npm install http-streamify
```

## Usage

### Creating a Stream from SSE Response

The `fromSSEResponse` method creates a Stream object from an SSE response.

从 SSE 响应创建 Stream 的示例

```javascript
const response = await fetch('/sse-endpoint');
const controller = new AbortController();
const stream = Stream.fromSSEResponse(response, controller);

for await (const data of stream) {
  console.log(data); // { event: 'message', data: 'Hello, world!' }
}
```

### Creating a Stream from Readable Stream

The `fromReadableStream` method creates a Stream object from a readable stream, where each item is a newline-delimited JSON value.

从可读流创建 Stream 的示例

```javascript
// const readableStream = new ReadableStream(/* ... */);
const readableStream = fetch('/readable-stream-endpoint');
const controller = new AbortController();
const stream = Stream.fromReadableStream(readableStream, controller);

for await (const data of stream) {
  console.log(data); // { event: 'message', data: 'Hello, world!' }
}
```

## License

MIT
