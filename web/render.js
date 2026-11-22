import { parse, renderHTML } from "@djot/djot";

let looseTaskLists = 0;

export function renderDjotHTML(text) {
  return renderHTML(parse(text, { sourcePositions: true }), {
    overrides: {
      task_list(node, renderer) {
        looseTaskLists += 1;
        const result = renderer.renderTag("ul", node, { class: "task-list" })
          + renderer.renderChildren(node)
          + renderer.renderCloseTag("ul");
        looseTaskLists -= 1;
        return result + "\n";
      },
      task_list_item(node, renderer) {
        const checkbox = node.checkbox === "checked"
          ? '<input disabled="" type="checkbox" checked=""/>' 
          : '<input disabled="" type="checkbox"/>';
        let result = renderer.renderTag("li", node) + "\n";
        if (looseTaskLists > 0 && node.children[0]?.tag === "para") {
          const first = node.children[0];
          result += renderer.renderTag("p", first);
          result += checkbox + " ";
          result += renderer.renderChildren(first);
          result += renderer.renderCloseTag("p") + "\n";
          for (const child of node.children.slice(1))
            result += renderer.renderAstNode(child);
        } else {
          result += checkbox + "\n";
          result += renderer.renderChildren(node);
        }
        return result + renderer.renderCloseTag("li") + "\n";
      },
    },
  });
}
