// 快速完成不显示忙碌提示；持续等待才提示，结束或卸载时立即清理。
export function delayedFeedback(
  change: (visible: boolean) => void,
  delay = 600,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    set(value: boolean) {
      if (value === pending) return;
      pending = value;
      clear();
      if (value) timer = setTimeout(() => change(true), delay);
      else change(false);
    },
    dispose() {
      pending = false;
      clear();
    },
  };
}
