(() => {
  // Register before the site's capture listeners. A closed shadow root exposes
  // its host as the event target, so YouTube cannot recognize our text fields.
  for (const type of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(
      type,
      (event) => {
        if (
          !event
            .composedPath()
            .some((node) => node.id === "morphe-jam-extension")
        )
          return;
        event.stopImmediatePropagation();
        // Do not preventDefault: typing, selection, paste and Tab must still work.
        if (type === "keydown" && event.key === "Escape") {
          document
            .getElementById("morphe-jam-extension")
            ?.dispatchEvent(new Event("jam-close"));
        }
      },
      true,
    );
  }
})();
