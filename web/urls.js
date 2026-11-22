export function imageURL(src, path) {
  if (!src) return null;
  try {
    const base = new URL(path || "", "https://luochu.invalid/"), url = new URL(src, base);
    if (url.origin === "https://luochu.invalid") {
      const file = decodeURIComponent(url.pathname.slice(1));
      return `api/file?path=${encodeURIComponent(file)}`;
    }
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return null;
    throw error;
  }
}
