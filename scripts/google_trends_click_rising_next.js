(function () {
  function text(element) {
    return (element && (element.innerText || element.textContent) || "").trim();
  }

  function findWidget() {
    const widgets = Array.from(document.querySelectorAll(".fe-related-queries"));
    return widgets.find((widget) => {
      const value = text(widget);
      return /搜索查询|Related queries|Consultas de pesquisa/i.test(value) &&
        /搜索量上升|Rising|Em ascensão/i.test(value);
    }) || widgets.find((widget) => /搜索查询|Related queries/i.test(text(widget))) || widgets[1] || widgets[0];
  }

  const widget = findWidget();
  const scopes = [];
  for (let node = widget, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
    scopes.push(node);
  }
  scopes.push(document);

  for (const scope of scopes) {
    const buttons = Array.from(scope.querySelectorAll(
      'button[aria-label="下一页"],button[aria-label="Next"],button[aria-label="Próxima"],button[aria-label="Suivant"]',
    ));
    for (const button of buttons) {
      if (!button.disabled && button.getAttribute("aria-disabled") !== "true") {
        button.click();
        return "CLICKED";
      }
    }
  }

  return "NO_NEXT";
})();
