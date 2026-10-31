# coc-spring-dashboard

Spring Boot dashboard for [coc.nvim](https://github.com/neoclide/coc.nvim):
tree views of the Spring Boot apps of the workspace, their beans, endpoint
mappings, properties and memory, and signs on bean definitions and request
mappings in the code.

It is a port of
[microsoft/vscode-spring-boot-dashboard](https://github.com/microsoft/vscode-spring-boot-dashboard)
(MIT). See [NOTICE](NOTICE) and [LICENSE](LICENSE).

Using it inside Neovim is described in the help page:
`:help coc-spring-dashboard`.

## Requirements

- coc-java and coc-springboot, installed and active (declared as extension
  dependencies). The dashboard gets all of its data through them and waits
  for their servers to start; until then it says "Java server starting" or
  "Spring Boot server not running".
- For live data (running state, live beans and mappings, properties,
  memory), a running app with `spring-boot-starter-actuator` on its
  classpath, started with these JVM arguments:

  ```
  -Dspring.jmx.enabled=true -Dmanagement.endpoints.jmx.exposure.include=*
  ```

- For apps that run on your machine, this coc-springboot setting in
  `coc-settings.json`:

  ```json
  "boot-java.live-information.all-local-java-processes": true
  ```

- For Debug and Attach debugger, [nvim-dap](https://github.com/mfussenegger/nvim-dap)
  in Neovim or [vimspector](https://github.com/puremourning/vimspector) in Vim
  and Neovim. Run needs no debugger.

Run, Debug and Stop are done by the dashboard: it opens a
launch panel (profiles, server port, logging, JVM options, program arguments
and environment, remembered per app), starts the JVM in a tab per app, the
dashboard of the app (Beans, Mappings, Properties and Memory over the terminal), and stops it with SIGTERM and then SIGKILL. The JMX arguments above
are added for you for apps it starts.

## Installation

```vim
:CocInstall coc-spring-dashboard
```

Or build a checkout and add its folder to the runtimepath with your plugin
manager:

```sh
npm ci
npm run build
```

## Settings

Set these keys in `coc-settings.json` (`:CocConfig` opens it).

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `spring.dashboard.openUrl` | string | `"{protocol}://{hostname}:{port}{contextPath}"` | Url template of an app, {protocol} {hostname} {port} {contextPath}. |
| `spring.dashboard.memory-view.fetch-data.delay-in-milliseconds` | number | `5000` | Interval of the memory metrics poll. |
| `spring.dashboard.memory-view.display-data.max-datapoints` | number | `10` | Width of the memory sparklines. |
| `spring.dashboard.enableGutter` | string (`on`, `off`) | `"on"` | Signs on the bean definitions and request mappings. |
| `spring.dashboard.debug.attachTimeout` | number | `30` | Seconds to wait for a debugger to attach; the app is killed after that. |
| `spring.dashboard.stop.gracePeriod` | number | `10` | Seconds between Stop (SIGTERM) and the kill (SIGKILL). |
| `spring.dashboard.launch.prompt` | string | `first` | When the launch panel opens: `first` (first time per app), `always` or `never`. |
| `spring.dashboard.launch.focusOutput` | boolean | `false` | Switch to the dashboard tab of an app when it is started. |
| `spring.dashboard.apps` | object | `{}` | Default launch settings per app name (`profiles`, `port`, `logLevel`, `logPackages`, `debugReport`, `vmArgs`, `args`, `env`), e.g. `{ "my-app": { "vmArgs": "-Xmx512m" } }`. |

Remote apps are listed in `boot-java.remote-apps`, a coc-springboot
setting; see `:help coc-spring-dashboard-remote`.

## Troubleshooting

- Failed requests to the Spring language server are logged to the output
  channel "Spring Dashboard":
  `:CocCommand workspace.showOutput Spring Dashboard`.
- Jumps from the views open in the window the app was started from, or the
  first normal window of the previous tab when you are in an app tab.
- No trees, or a warning that coc-springboot or coc-java is not active:
  check `:CocList extensions` and open a Java file of the project.
- An app stays `○ stopped` while it runs: check the actuator dependency, the
  JVM arguments and `boot-java.live-information.all-local-java-processes`
  above, then run `:CocCommand spring.dashboard.livedata.refresh`.
- Every message the dashboard shows is explained in
  `:help coc-spring-dashboard-messages`.

## Development

```sh
npm ci
npm run build
npm run typecheck
```
