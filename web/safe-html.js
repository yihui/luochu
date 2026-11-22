import DOMPurify from "dompurify";
import { imageURL } from "./urls.js";

export function sanitizeHTML(html, path) {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "base", "link",
      "meta", "svg", "math", "audio", "video", "source", "template"],
    FORBID_ATTR: ["srcset", "autofocus"],
  });
  for (const node of fragment.querySelectorAll("[style]")) {
    if (node.matches("th, td")) {
      const match = /^text-align:\s*(left|center|right);?$/.exec(node.getAttribute("style").trim());
      if (match) node.classList.add(`dj-al-${match[1]}`);
    }
    node.removeAttribute("style");
  }
  for (const img of fragment.querySelectorAll("img")) {
    const src = imageURL(img.getAttribute("src") || "", path);
    if (src) img.setAttribute("src", src);
    else img.removeAttribute("src");
    img.referrerPolicy = "no-referrer";
  }
  for (const input of fragment.querySelectorAll("input")) {
    if (input.type !== "checkbox") input.remove();
    else input.disabled = true;
  }
  return fragment;
}
