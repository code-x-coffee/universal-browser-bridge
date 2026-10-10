// Original selector generation. Prefer a unique ID, otherwise use an exact
// structural path. Closed shadow roots and frame documents are outside v1.
(function () {
  const selectorFor = (element) => {
    if (!element || element.getRootNode() !== document) return null;
    const parts = [];
    for (let node = element; node; node = node.parentElement) {
      if (node.id) {
        const id = `#${CSS.escape(node.id)}`;
        if (document.querySelectorAll(id).length === 1) {
          parts.unshift(id);
          break;
        }
      }
      const tag = CSS.escape(node.localName);
      const siblings = node.parentElement ? [...node.parentElement.children].filter((sibling) => sibling.localName === node.localName) : [node];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    }
    const selector = parts.join(" > ");
    return document.querySelector(selector) === element ? selector : null;
  };
  const pageRect = (rect) => ({ x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height });
  globalThis.__ubbAnnotationUtils = { selectorFor, pageRect };
})();
