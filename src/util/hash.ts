/** SHA-256 hex digest — works on desktop and mobile via Web Crypto. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  let ab: ArrayBuffer;
  if (typeof data === "string") {
    const encoded = new TextEncoder().encode(data);
    ab = encoded.buffer;
  } else if (data instanceof ArrayBuffer) {
    ab = data;
  } else if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    ab = data.buffer;
  } else {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    ab = copy.buffer;
  }

  const digest = await crypto.subtle.digest("SHA-256", ab);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Binary(data: ArrayBuffer): Promise<string> {
  return sha256Hex(data);
}
