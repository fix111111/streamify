// Import the APIError class
import { APIError } from './error';

// Define the Stream class
export class Stream {
  // Constructor that takes an iterator and a controller
  constructor(iterator, controller) {
    this.iterator = iterator;
    this.controller = controller;
  }

  // Create a Stream object from an SSE response
  static fromSSEResponse(response, controller) {
    let consumed = false; // Flag to indicate if the stream has been consumed

    // Define an asynchronous iterator function for handling SSE messages
    async function* iterator() {
      if (consumed) {
        throw new Error('Cannot iterate over a consumed stream, use `.tee()` to split the stream.');
      }
      consumed = true; // Mark the stream as consumed
      let done = false; // Flag to indicate if iteration is complete

      // Iterate over SSE messages
      try {
        for await (const sse of _iterSSEMessages(response, controller)) {
          if (done) continue; // Skip if iteration is complete

          // Check if the message indicates the end of the stream
          if (sse.data.startsWith('[DONE]')) {
            done = true;
            continue;
          }

          // Process non-end messages
          if (sse.event === null) {
            let data;

            // Attempt to parse JSON data
            try {
              data = JSON.parse(sse.data);
            } catch (e) {
              console.error(`Could not parse message into JSON:`, sse.data);
              console.error(`From chunk:`, sse.raw);
              throw e;
            }

            // Check for errors in the data
            if (data) {
              if (data.error) {
                throw new APIError(undefined, data.error, undefined, undefined);
              } else if (data.err) {
                throw new APIError(undefined, data.err, undefined, undefined);
              }
            }

            // Yield the parsed data
            yield data;
          } else {
            let data;
            try {
              data = JSON.parse(sse.data);
            } catch (e) {
              console.error(`Could not parse message into JSON:`, sse.data);
              console.error(`From chunk:`, sse.raw);
              throw e;
            }
            // Throw an APIError if the event type is an error
            if (sse.event == 'error') {
              throw new APIError(undefined, data.error, data.message, undefined);
            }
            yield { event: sse.event, data: data };
          }
        }
        done = true; // Mark iteration as complete
      } catch (e) {
        // Exit without throwing an error if the user called `stream.controller.abort()`
        if (e instanceof Error && e.name === 'AbortError') return;
        throw e;
      } finally {
        // Abort ongoing requests if the user `break`s
        if (!done) controller.abort();
      }
    }

    // Return the new Stream object
    return new Stream(iterator, controller);
  }

  // Create a Stream object from a newline-delimited readable stream, where each item is a JSON value
  static fromReadableStream(readableStream, controller) {
    let consumed = false; // Flag to indicate if the stream has been consumed

    // Define an asynchronous generator function for iterating over the readable stream line by line
    async function* iterLines() {
      const lineDecoder = new LineDecoder(); // Create a LineDecoder instance for decoding lines of data
      const iter = readableStreamAsyncIterable(readableStream); // Get the iterable object

      // Process chunks of data from the stream
      for await (const chunk of iter) {
        for (const line of lineDecoder.decode(chunk)) {
          yield line; // Yield each line
        }
      }

      // Process any remaining buffered data
      for (const line of lineDecoder.flush()) {
        yield line;
      }
    }

    // Define an asynchronous iterator function
    async function* iterator() {
      if (consumed) {
        throw new Error('Cannot iterate over a consumed stream, use `.tee()` to split the stream.');
      }
      consumed = true; // Mark the stream as consumed
      let done = false; // Flag to indicate if iteration is complete

      // Process lines of data from the stream
      try {
        for await (const line of iterLines()) {
          if (done) continue; // Skip if iteration is complete
          if (line) yield JSON.parse(line); // Parse and yield each line of JSON data
        }
        done = true; // Mark iteration as complete
      } catch (e) {
        // Exit without throwing an error if the user called `stream.controller.abort()`
        if (e instanceof Error && e.name === 'AbortError') return;
        throw e;
      } finally {
        // Abort ongoing requests if the user `break`s
        if (!done) controller.abort();
      }
    }

    // Return a new Stream object
    return new Stream(iterator, controller);
  }

  // Implement the asynchronous iterator protocol
  [Symbol.asyncIterator]() {
    return this.iterator();
  }

  // Split the stream into two independent streams that can be read at different speeds
  tee() {
    const left = [];
    const right = [];
    const iterator = this.iterator();

    const teeIterator = queue => {
      return {
        next: () => {
          if (queue.length === 0) {
            const result = iterator.next();
            left.push(result);
            right.push(result);
          }
          return queue.shift();
        },
      };
    };

    return [
      new Stream(() => teeIterator(left), this.controller),
      new Stream(() => teeIterator(right), this.controller),
    ];
  }

  // Convert this stream into a newline-delimited readable stream, where the values in the stream are JSON stringified
  toReadableStream() {
    const self = this;
    let iter;
    const encoder = new TextEncoder();

    return new ReadableStream({
      async start() {
        iter = self[Symbol.asyncIterator](); // Get the asynchronous iterator
      },
      async pull(ctrl) {
        try {
          const { value, done } = await iter.next();
          if (done) return ctrl.close(); // Close the stream

          const bytes = encoder.encode(JSON.stringify(value) + '\n');
          ctrl.enqueue(bytes); // Enqueue the byte sequence
        } catch (err) {
          ctrl.error(err);
        }
      },
      async cancel() {
        await iter.return?.(); // Cancel the iteration
      },
    });
  }
}

// LineDecoder class for decoding input data line by line
export class LineDecoder {
  static NEWLINE_CHARS = new Set(['\n', '\r']); // Set of newline characters for identifying newline sequences

  // Regular expression for matching various newline combinations:
  // 1. \r\n: Windows newline
  // 2. \n: Unix newline
  // 3. \r: Old Mac newline
  // This ensures correct handling of data from different platforms or network protocols.
  static NEWLINE_REGEXP = /\r\n|[\n\r]/g;

  constructor() {
    // Buffer for storing incomplete line data
    this.buffer = [];
    // Flag for indicating if there's a trailing carriage return
    this.trailingCR = false;
  }

  // Decode lines from the input data chunk
  decode(chunk) {
    // Decode the byte data into text
    let text = this.decodeText(chunk);

    // Handle trailing carriage return
    if (this.trailingCR) {
      text = '\r' + text; // If the previous chunk ended with \r, prepend it to the current text
      this.trailingCR = false; // Reset the trailingCR flag
    }
    if (text.endsWith('\r')) {
      this.trailingCR = true; // If the current text ends with \r, set the trailingCR flag
      text = text.slice(0, -1); // Remove the trailing \r
    }

    // Return an empty array if the decoded text is empty
    if (!text) {
      return [];
    }

    // Split the text into lines using the newline regular expression
    const trailingNewline = LineDecoder.NEWLINE_CHARS.has(text[text.length - 1] || '');
    let lines = text.split(LineDecoder.NEWLINE_REGEXP);

    // Remove the last empty line if the text ends with a newline
    if (trailingNewline) {
      lines.pop();
    }

    // Add the line to the buffer if there's only one line and no trailing newline
    if (lines.length === 1 && !trailingNewline) {
      this.buffer.push(lines[0]);
      return []; // Return an empty array since the line is incomplete
    }

    // Merge incomplete lines: if there's incomplete data in the buffer, combine it with the current lines
    if (this.buffer.length > 0) {
      lines = [this.buffer.join('') + lines[0], ...lines.slice(1)];
      this.buffer = []; // Clear the buffer
    }

    // Update the buffer: store the last line in the buffer if there's no trailing newline
    if (!trailingNewline) {
      this.buffer = [lines.pop() || ''];
    }

    // Return the decoded lines
    return lines;
  }

  // Decode byte data into text
  decodeText(bytes) {
    // Handle empty data and return an empty string
    if (bytes == null) return '';
    // Return the bytes directly if it's already a string
    if (typeof bytes === 'string') return bytes;

    // Handle Buffer and Uint8Array data in Node.js environment
    if (typeof Buffer !== 'undefined') {
      // Convert Buffer to string
      if (bytes instanceof Buffer) {
        return bytes.toString();
      }

      // Convert Uint8Array to Buffer and then to string
      if (bytes instanceof Uint8Array) {
        return Buffer.from(bytes).toString();
      }

      throw new Error(
        `Unexpected: received non-Uint8Array (${bytes.constructor.name}) stream chunk in an environment with a global "Buffer" defined, which this library assumes to be Node. Please report this error.`,
      );
    }

    // Handle Uint8Array and ArrayBuffer data in browser environment
    if (typeof TextDecoder !== 'undefined') {
      if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) {
        this.textDecoder ||= new TextDecoder('utf8'); // Create or reuse a TextDecoder instance
        return this.textDecoder.decode(bytes); // Decode using TextDecoder
      }

      throw new Error(
        `Unexpected: received non-Uint8Array/ArrayBuffer (${bytes.constructor.name}) in a web platform. Please report this error.`,
      );
    }

    // Throw an error if neither Buffer nor TextDecoder are available
    throw new Error(
      `Unexpected: neither Buffer nor TextDecoder are available as globals. Please report this error.`,
    );
  }

  // Process remaining data in the buffer
  flush() {
    // Return an empty array if there's no incomplete line and no trailing carriage return
    if (!this.buffer.length && !this.trailingCR) {
      return [];
    }

    const lines = [this.buffer.join('')]; // Return the incomplete line from the buffer
    this.buffer = []; // Clear the buffer
    this.trailingCR = false; // Reset the trailingCR flag
    return lines; // Return the buffered line
  }
}

// SSEDecoder class for decoding SSE messages
class SSEDecoder {
  constructor() {
    // Store the current event type, data lines, and all decoded lines (including unprocessed lines)
    this.event = null;
    this.data = [];
    this.chunks = [];
  }

  // Decode a line of data into an SSE message
  decode(line) {
    // Handle carriage returns
    // If the line ends with \r, remove it. SSE message lines can end with \n or \r\n, so normalizing to \n helps with parsing.
    if (line.endsWith('\r')) {
      line = line.substring(0, line.length - 1);
    }

    // Handle empty lines: empty lines signify the end of an event
    // If both event and data are empty, return null indicating an invalid empty line.
    // Otherwise, assemble the current event into an object sse and return it, resetting this.event, this.data, and this.chunks for the next event.
    if (!line) {
      if (!this.event && !this.data.length) return null;

      const sse = {
        event: this.event,
        data: this.data.join('\n'),
        raw: this.chunks,
      };

      this.event = null;
      this.data = [];
      this.chunks = [];

      return sse;
    }

    // Store the current line: add the line to this.chunks, recording all processed lines.
    this.chunks.push(line);

    // Skip comment lines: if the line starts with :, it's a comment line, so skip it.
    if (line.startsWith(':')) {
      return null;
    }

    // Split the line data: use the partition function to split the line into field name and field value.
    // Remove leading space from the field value if present.
    let [fieldname, , value] = partition(line, ':');
    if (value.startsWith(' ')) {
      value = value.substring(1);
    }

    // Parse the fields:
    // If the field name is event, store the field value as this.event.
    // If the field name is data, add the field value to this.data, supporting multiline data.
    if (fieldname === 'event') {
      this.event = value;
    } else if (fieldname === 'data') {
      this.data.push(value);
    }

    // Return null: after processing a line, unless an empty line is encountered to end an event, return null indicating the current line has been processed.
    return null;
  }
}

// Convert a readable stream into an asynchronous iterable object
export function readableStreamAsyncIterable(stream) {
  // Check if the stream already implements Symbol.asyncIterator, and return it if so
  // The readableStreamAsyncIterable function takes a readable stream stream as its input parameter.
  // Check if the stream already implements the Symbol.asyncIterator method. If it does, return the stream directly. This ensures that if the stream is already an asynchronous iterable, it doesn't need to be wrapped again.
  if (stream[Symbol.asyncIterator]) return stream;

  // Use the getReader method to get the stream's reader
  const reader = stream.getReader();

  // Return an object that implements the asynchronous iterator protocol
  return {
    // Implement the next method to read chunks of data from the stream
    async next() {
      try {
        // Use the reader.read method to asynchronously read a chunk of data from the stream. The read method returns an object with value and done properties.
        const result = await reader.read();
        // If the result indicates the stream is closed (result.done is true), release the reader's lock to allow other readers to access the stream.
        if (result?.done) reader.releaseLock();
        // Return the read result
        return result;
      } catch (e) {
        // If an error occurs during reading, release the reader's lock and throw the error.
        reader.releaseLock();
        throw e;
      }
    },

    // Implement the return method to terminate the iteration early
    async return() {
      // Call the reader.cancel method to cancel the read operation and release the reader's lock.
      const cancelPromise = reader.cancel();
      reader.releaseLock(); // Release the reader's lock
      await cancelPromise; // Wait for the cancel operation to complete
      // After the cancel operation is complete, return { done: true, value: undefined } to indicate the iteration is complete.
      return { done: true, value: undefined };
    },

    // Implement the Symbol.asyncIterator method to return this, making the object itself an asynchronous iterator
    // Return this to indicate that the object itself is an asynchronous iterator, allowing it to be used in for await...of loops.
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

// Iterate over SSE messages
export async function* _iterSSEMessages(response, controller) {
  if (!response.body) {
    controller.abort();
    throw new Error('Attempted to iterate over a response with no body');
  }

  // Used to decode SSE message lines and assemble them into complete message objects.
  const sseDecoder = new SSEDecoder();
  // Used to decode byte data read from the stream into lines of text.
  const lineDecoder = new LineDecoder();

  // Convert a readable stream into an asynchronous iterable object to use in for await...of loops.
  const iter = readableStreamAsyncIterable(response.body);
  for await (const sseChunk of iterSSEChunks(iter)) {
    for (const line of lineDecoder.decode(sseChunk)) {
      const sse = sseDecoder.decode(line);
      if (sse) yield sse;
    }
  }

  for (const line of lineDecoder.flush()) {
    const sse = sseDecoder.decode(line);
    if (sse) yield sse;
  }
}

// iterSSEChunks function to iterate over asynchronous iterable objects and generate complete SSE chunks
async function* iterSSEChunks(iterator) {
  // Initialize the data variable to an empty Uint8Array to store the current data chunk being processed.
  let data = new Uint8Array();

  // Asynchronous iterator loop:
  // Use for await...of syntax to iterate over the iterator and read chunks of data.
  for await (const chunk of iterator) {
    // Skip the current loop if the read chunk is null.
    if (chunk == null) {
      continue;
    }

    // Convert the chunk to Uint8Array:
    // Convert the chunk to Uint8Array for uniform processing.
    // If the chunk is ArrayBuffer, convert it to Uint8Array.
    // If the chunk is a string, use TextEncoder to encode it to Uint8Array.
    // Otherwise, assume the chunk is already Uint8Array.
    const binaryChunk =
      chunk instanceof ArrayBuffer
        ? new Uint8Array(chunk)
        : typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : chunk;

    // Merge the data chunks:
    // Create a new Uint8Array with a length equal to the total length of data and binaryChunk.
    // Copy the data to the beginning of newData.
    // Copy the binaryChunk to newData after the data.
    // Update the data to the merged newData.
    let newData = new Uint8Array(data.length + binaryChunk.length);
    newData.set(data);
    newData.set(binaryChunk, data.length);
    data = newData;

    // Find the index of the double newline:
    // Use the findDoubleNewlineIndex function to find the index of the double newline.
    // If a double newline is found, patternIndex will be its index.
    let patternIndex;
    while ((patternIndex = findDoubleNewlineIndex(data)) !== -1) {
      // Generate a complete SSE chunk:
      // Use yield to generate a subarray from the beginning of data to the index of the double newline, representing a complete SSE chunk.
      // Update the data to the remaining part after the double newline.
      yield data.slice(0, patternIndex);
      data = data.slice(patternIndex);
    }
  }

  // Handle remaining data:
  // If data still has remaining parts after the iteration, generate the remaining part.
  if (data.length > 0) {
    yield data;
  }
}

// findDoubleNewlineIndex function to find the index of a double newline in a buffer.
// This function searches for the ending patterns (\r\r, \n\n, \r\n\r\n) in the buffer
// and returns the position after the first occurrence of any pattern,
// returning -1 if no pattern is found.
function findDoubleNewlineIndex(buffer) {
  const newline = 0x0a; // Represents \n
  const carriage = 0x0d; // Represents \r

  // Traverse the buffer:
  // Traverse the buffer to find the index of the double newline combinations.
  // Find the \n\n combination and return the index plus 2.
  // Find the \r\r combination and return the index plus 2.
  // Find the \r\n\r\n combination and return the index plus 4.
  for (let i = 0; i < buffer.length - 2; i++) {
    if (buffer[i] === newline && buffer[i + 1] === newline) {
      // \n\n
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === carriage) {
      // \r\r
      return i + 2;
    }
    if (
      buffer[i] === carriage &&
      buffer[i + 1] === newline &&
      i + 3 < buffer.length &&
      buffer[i + 2] === carriage &&
      buffer[i + 3] === newline
    ) {
      // \r\n\r\n
      return i + 4;
    }
  }

  // No double newline found:
  return -1;
}

// Function to split a string str using a specified delimiter and return an array containing three elements: the part before the delimiter, the delimiter itself, and the part after the delimiter.
function partition(str, delimiter) {
  // Find the position of the delimiter in the string
  const index = str.indexOf(delimiter);

  // Handle the case when the delimiter is found:
  // If index is not equal to -1, the delimiter is found.
  // Use the substring method to split the string:
  // str.substring(0, index): Get the part before the delimiter.
  // delimiter: The delimiter itself.
  // str.substring(index + delimiter.length): Get the part after the delimiter.
  // Return an array containing these three parts.
  if (index !== -1) {
    return [str.substring(0, index), delimiter, str.substring(index + delimiter.length)];
  }

  // Handle the case when the delimiter is not found:
  // If index equals -1, the delimiter is not found.
  // Return an array containing the original string and two empty strings.
  return [str, '', ''];
}
