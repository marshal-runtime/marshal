// iOS pans the visual viewport when focusing an editor; height alone cannot
// keep a fixed app visible. Follow both its size and its position.
export function installRemoteViewport() {
  const viewport = window.visualViewport;
  let frame = 0;
  const update = () => {
    const style = document.documentElement.style;
    document.documentElement.toggleAttribute(
      "data-keyboard",
      (viewport?.height ?? window.innerHeight) < window.innerHeight - 100,
    );
    style.setProperty("--remote-height", `${viewport?.height ?? window.innerHeight}px`);
    style.setProperty("--remote-top", `${viewport?.offsetTop ?? 0}px`);
    style.setProperty("--remote-left", `${viewport?.offsetLeft ?? 0}px`);
    style.setProperty("--remote-width", `${viewport?.width ?? window.innerWidth}px`);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };
  update();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("pageshow", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  return () => {
    cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("pageshow", schedule);
    document.removeEventListener("focusin", schedule);
    document.removeEventListener("focusout", schedule);
  };
}
