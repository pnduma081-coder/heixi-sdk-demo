(() => {
  let mounts = 0;
  window.BlackRhinoSDK = {
    init(options) {
      return async (input) => {
        try {
          await options.getSignature({
            parentOrigin: "https://127.0.0.1:3443",
            signal: input.signal,
          });
        } catch {
          throw Object.assign(new Error("SDK initialization failed."), {
            code: "INITIALIZATION_FAILED",
          });
        }
        if (input.signal.aborted) throw new Error("aborted");
        const number = ++mounts;
        const frame = document.createElement("iframe");
        frame.title = "SDK 隔离验收";
        if (window.__SDK_FIXTURE_STALLED_FRAME__) {
          frame.src = new URL(
            "/__sdk-fixture__/embed?instanceId=fixture-pending",
            window.location.origin,
          ).href;
          input.container.append(frame);
          return new Promise((_resolve, reject) => {
            input.signal.addEventListener(
              "abort",
              () => {
                frame.remove();
                reject(
                  Object.assign(new Error("SDK disposed"), {
                    code: "DISPOSED",
                  }),
                );
              },
              { once: true },
            );
          });
        }
        let target = input.page,
          navigations = 0,
          failedNavigation = false;
        const render = () => {
          frame.srcdoc = `<html lang="zh-CN"><body style="font:14px system-ui;margin:0;padding:38px;background:#fff;color:#414354"><p style="font-size:12px;color:#a39bb5">隔离 SDK 夹具 · 不调用真实平台或模型</p><h1 style="font-size:26px;margin-top:50px">${target}</h1><p>当前用户：${input.profile.displayName}</p><p>装载次数：${number} · 导航次数：${navigations}</p><p>此区域由 SDK 实例装载，宿主菜单负责切换功能。</p></body></html>`;
        };
        render();
        input.container.append(frame);
        input.signal.addEventListener("abort", () => frame.remove(), {
          once: true,
        });
        return {
          ready: Promise.resolve({ capabilities: [] }),
          navigate: async (next) => {
            if (window.__SDK_FIXTURE_NAVIGATION__ === "slow")
              await new Promise((resolve) => setTimeout(resolve, 5000));
            if (
              window.__SDK_FIXTURE_NAVIGATION__ === "fail" &&
              !failedNavigation
            ) {
              failedNavigation = true;
              throw Object.assign(
                new Error(
                  "private SDK trace https://localhost:18080 secret-value",
                ),
                { code: "OPERATION_FAILED" },
              );
            }
            if (input.signal.aborted) throw new Error("aborted");
            target = next.page;
            navigations++;
            render();
          },
          update: async () => {
            if (window.__SDK_FIXTURE_SLOW_UPDATE__) await new Promise(() => {});
          },
          getState: () => ({ target }),
          refreshSession: async () => {},
          destroy: () => frame.remove(),
        };
      };
    },
  };
})();
