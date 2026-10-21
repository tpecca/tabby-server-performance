// Tabby plugin: shows live stats for the host behind each SSH tab.
// For Tabby SSH tabs, stats are collected over a short-lived exec channel on the
// tab's existing SSH connection, so no extra login or credentials are needed.
// For local tabs where you typed `ssh ...` yourself, that connection belongs to the
// OpenSSH binary, so the plugin opens its own non-interactive, multiplexed one with
// the same arguments (key/agent auth, or a ControlMaster you already have).
// Plain CommonJS on purpose: Tabby resolves @angular/core and tabby-terminal
// to its own instances at runtime, so there's nothing to bundle.

const { execFile, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { NgModule, Injectable, NgZone } = require('@angular/core')
const { TerminalDecorator } = require('tabby-terminal')

const POLL_MS = 3000
// The first sample has no CPU/NET rates yet, so take the second one sooner.
const FIRST_SAMPLE_MS = 1000
// While the user is still logging in, only the local control socket is checked.
const LOGIN_WAIT_MS = 1000
const ERROR_BACKOFF_MS = 15000
const EXEC_TIMEOUT_MS = 10000
const COLLAPSED_KEY = 'tabby-server-performance:collapsed'
// Short and fixed: unix socket paths are capped at ~104 bytes on macOS.
const CONTROL_DIR = `/tmp/tsp-${os.userInfo().uid}`

// OpenSSH flags that take an argument (from ssh's getopt string).
const SSH_ARG_FLAGS = new Set('BDEFIJLOQRSWbceilmopw')
// Flags not carried over to the stats connection: forwards, logging, tty/background
// modes and one-shot commands would clash with the user's session or with `sh -s`.
const SSH_DROP_FLAGS = new Set('DEGLMNOQRSTVWefnqstvwxXyY')
// Overrides for the stats connection. ClearAllForwardings also covers forwards from ~/.ssh/config.
const SSH_STATS_OPTIONS = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'RequestTTY=no',
    '-o', 'RemoteCommand=none',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
]

// Fed to `sh -s` on stdin, so no quoting games with the user's login shell.
// Every output line is "<tag> <values...>"; anything else (e.g. noisy rc files) is ignored.
const REMOTE_SCRIPT = `
export LC_ALL=C
if [ ! -r /proc/stat ]; then echo "err unsupported"; exit 0; fi
echo "cpu $(head -n1 /proc/stat | cut -c5-)"
echo "load $(cat /proc/loadavg)"
echo "ncpu $(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)"
awk '/^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):/{sub(":","",$1);print $1,$2}' /proc/meminfo
echo "uptime $(cut -d' ' -f1 /proc/uptime)"
df -Pk / 2>/dev/null | awk 'NR==2{print "disk",$2,$3,$4}'
awk 'NR>2{gsub(":"," ");if($1!~/^(lo|docker|veth|br-|virbr|cni|flannel|cali)/){rx+=$2;tx+=$10}}END{printf "net %.0f %.0f\\n",rx,tx}' /proc/net/dev
`

const STYLES = `
.tsp-bar {
    position: absolute; right: 10px; bottom: 6px; z-index: 5;
    display: flex; gap: 10px; align-items: center;
    padding: 2px 8px; border-radius: 6px;
    font: 11px/1.6 ui-monospace, Menlo, Monaco, monospace;
    color: #d7dae0; background: rgba(20, 22, 26, 0.72);
    backdrop-filter: blur(4px);
    white-space: nowrap; user-select: none; cursor: pointer;
}
.tsp-bar.tsp-collapsed .tsp-item { display: none; }
.tsp-bar .tsp-host { font-weight: 600; }
.tsp-bar .tsp-dot { width: 6px; height: 6px; border-radius: 50%; background: #7ec699; }
.tsp-bar.tsp-stale .tsp-dot { background: #e06c75; }
.tsp-bar.tsp-stale .tsp-item { opacity: 0.5; }
.tsp-bar .tsp-label { opacity: 0.6; margin-right: 3px; }
.tsp-ok { color: #7ec699; }
.tsp-warn { color: #e5c07b; }
.tsp-crit { color: #e06c75; }
`

function ensureStyles () {
    if (document.getElementById('tabby-server-performance-styles')) {
        return
    }
    const style = document.createElement('style')
    style.id = 'tabby-server-performance-styles'
    style.textContent = STYLES
    document.head.appendChild(style)
}

function readCollapsed () {
    try {
        return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
        return false
    }
}

function writeCollapsed (value) {
    try {
        localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0')
    } catch { }
}

async function execRemote (sshSession, script) {
    const client = sshSession.ssh
    const channel = await client.activateChannel(await client.openSessionChannel())
    return new Promise((resolve, reject) => {
        const chunks = []
        const subscriptions = []
        let done = false
        let eofTimer = null
        const finish = error => {
            if (done) {
                return
            }
            done = true
            clearTimeout(timeout)
            clearTimeout(eofTimer)
            subscriptions.forEach(s => s.unsubscribe())
            channel.close().catch(() => null)
            if (error) {
                reject(error)
            } else {
                resolve(Buffer.concat(chunks).toString('utf8'))
            }
        }
        const timeout = setTimeout(() => finish(new Error('timed out')), EXEC_TIMEOUT_MS)
        subscriptions.push(channel.data$.subscribe(data => chunks.push(Buffer.from(data))))
        subscriptions.push(channel.closed$.subscribe(() => finish()))
        // Some servers send EOF but are slow to close; don't wait forever for the close.
        subscriptions.push(channel.eof$.subscribe(() => {
            eofTimer = setTimeout(() => finish(), 500)
        }))
        channel.requestExec('sh -s')
            .then(() => channel.write(new TextEncoder().encode(script)))
            .then(() => channel.eof())
            .catch(finish)
    })
}

// Splits an ssh argv into the options worth reusing and the destination, or null if it
// isn't an interactive login we can follow (e.g. `ssh -V`, `ssh -O exit host`).
function parseSshArgs (args) {
    const options = []
    let i = 0
    while (i < args.length) {
        const arg = args[i]
        if (arg === '--') {
            i++
            break
        }
        if (!arg.startsWith('-') || arg === '-') {
            break
        }
        // Flags can be bundled (-4A) and an argument can be attached (-p2222) or separate (-p 2222).
        for (let j = 1; j < arg.length; j++) {
            const flag = arg[j]
            if (flag === 'G' || flag === 'V' || flag === 'O' || flag === 'Q') {
                return null
            }
            if (SSH_ARG_FLAGS.has(flag)) {
                const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i]
                if (value === undefined) {
                    return null
                }
                if (!SSH_DROP_FLAGS.has(flag)) {
                    options.push(`-${flag}`, value)
                }
                break
            }
            if (!SSH_DROP_FLAGS.has(flag)) {
                options.push(`-${flag}`)
            }
        }
        i++
    }
    const destination = args[i]
    return destination ? { options, destination } : null
}

function run (file, args, { input, timeout = EXEC_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        const out = []
        const err = []
        let done = false
        const finish = (error, code) => {
            if (done) {
                return
            }
            done = true
            clearTimeout(timer)
            if (error) {
                reject(error)
            } else if (code !== 0) {
                reject(new Error(Buffer.concat(err).toString('utf8').trim() || `exit code ${code}`))
            } else {
                resolve(Buffer.concat(out).toString('utf8'))
            }
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            finish(new Error('timed out'))
        }, timeout)
        child.stdout.on('data', data => out.push(data))
        child.stderr.on('data', data => err.push(data))
        child.on('error', error => finish(error))
        // 'close' waits for every pipe to close; a ControlPersist master that kept a pipe
        // open would stall it, so fall back to 'exit' shortly after the process is gone.
        child.on('close', code => finish(null, code))
        child.on('exit', code => setTimeout(() => finish(null, code), 300))
        child.stdin.on('error', () => null)
        child.stdin.end(input ?? '')
    })
}

let controlDirReady = false
function ensureControlDir () {
    if (!controlDirReady) {
        fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 })
        controlDirReady = true
    }
}

// Runs the script through the system ssh. If the user's config already multiplexes
// (ControlMaster + ControlPath), ride on their master; otherwise keep our own master
// alive for a minute so polls reuse one connection instead of logging in every 3s.
async function execOpenSSH (ssh, script) {
    if (ssh.ownControlPath === undefined) {
        const resolved = await run(ssh.binary, [...ssh.options, '-G', ssh.destination], { timeout: 5000 })
        const option = key => resolved.match(new RegExp(`^${key} (.*)$`, 'm'))?.[1]
        const userMux = option('controlmaster') !== 'false' && (option('controlpath') ?? 'none') !== 'none'
        ssh.ownControlPath = !userMux
    }
    if (!ssh.ownControlPath) {
        // Riding on the user's master: wait until their login has brought it up rather than
        // attempting our own (failing, BatchMode) login meanwhile. `-O check` only talks to
        // the local socket, never the server.
        const up = await run(ssh.binary, [...ssh.options, '-O', 'check', ssh.destination], { timeout: 2000 })
            .then(() => true, () => false)
        if (!up) {
            return null
        }
    }
    const mux = []
    if (ssh.ownControlPath) {
        ensureControlDir()
        mux.push(
            '-o', 'ControlMaster=auto',
            '-o', `ControlPath=${path.join(CONTROL_DIR, '%C')}`,
            '-o', 'ControlPersist=60',
        )
    }
    return run(ssh.binary, [...ssh.options, ...SSH_STATS_OPTIONS, ...mux, ssh.destination, 'sh -s'], { input: script })
}

function listProcesses () {
    return new Promise((resolve, reject) => {
        execFile('/bin/ps', ['-Aww', '-o', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(error)
                return
            }
            const processes = []
            for (const line of stdout.split('\n')) {
                const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
                if (match) {
                    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] })
                }
            }
            resolve(processes)
        })
    })
}

// Finds the most recently started ssh login anywhere under the given shell.
// ps joins argv with spaces, so arguments that contain spaces can't be recovered; such
// invocations are rare for interactive logins and are simply followed as best we can.
async function findSshUnder (rootPid) {
    const processes = await listProcesses()
    const children = new Map()
    for (const p of processes) {
        if (!children.has(p.ppid)) {
            children.set(p.ppid, [])
        }
        children.get(p.ppid).push(p)
    }
    let found = null
    const queue = [...children.get(rootPid) ?? []]
    while (queue.length) {
        const p = queue.shift()
        const [binary, ...args] = p.args.trim().split(/\s+/)
        if (path.basename(binary) === 'ssh') {
            const parsed = parseSshArgs(args)
            if (parsed && (!found || p.pid > found.pid)) {
                found = { pid: p.pid, binary: binary.startsWith('/') ? binary : 'ssh', ...parsed }
            }
            // ssh's own children are ProxyCommand/LocalCommand helpers, not logins.
            continue
        }
        queue.push(...children.get(p.pid) ?? [])
    }
    return found
}

function hostFromDestination (destination) {
    const host = destination.replace(/^ssh:\/\//, '').replace(/^.*@/, '')
    return host.replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/:\d+$/, '')
}

// Tabby SSH tabs: exec channels on the tab's own connection.
class TabbySshSource {
    constructor (terminal) {
        this.terminal = terminal
        this.idleMessage = 'not connected'
    }

    async current () {
        const session = this.terminal.sshSession
        if (!session || !session.open) {
            return null
        }
        const options = this.terminal.profile?.options ?? {}
        return {
            key: session,
            label: options.host ?? this.terminal.profile?.name ?? 'ssh',
            exec: script => execRemote(session, script),
        }
    }
}

// Local shell tabs: follow an `ssh ...` typed into the shell.
class LocalShellSource {
    constructor (terminal) {
        this.terminal = terminal
        // Plain local shells get no bar at all.
        this.idleMessage = null
        this.target = null
    }

    async current () {
        const pty = this.terminal.session?.pty
        if (!pty?.getPID) {
            return null
        }
        const ssh = await findSshUnder(await pty.getPID())
        if (!ssh) {
            this.target = null
            return null
        }
        if (this.target?.pid !== ssh.pid) {
            this.target = {
                ...ssh,
                key: `${ssh.pid}`,
                label: hostFromDestination(ssh.destination),
                exec: script => execOpenSSH(this.target, script),
            }
        }
        return this.target
    }
}

function parseOutput (text) {
    const fields = {}
    for (const line of text.split('\n')) {
        const [tag, ...values] = line.trim().split(/\s+/)
        if (tag) {
            fields[tag] = values
        }
    }
    return fields
}

// Short bar text for the usual ssh failures; the full message stays in the tooltip.
function describeError (message = '') {
    if (/Permission denied|Too many authentication failures/.test(message)) {
        return 'stats need key auth or ControlMaster'
    }
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION/.test(message)) {
        return 'stats: host key not trusted'
    }
    if (/timed out|Could not resolve|Connection refused|No route to host/.test(message)) {
        return 'stats: host unreachable'
    }
    return 'stats unavailable'
}

function severity (pct, warn, crit) {
    return pct >= crit ? 'tsp-crit' : pct >= warn ? 'tsp-warn' : 'tsp-ok'
}

function formatKiB (kib) {
    const gib = kib / 1024 / 1024
    return gib >= 10 ? `${gib.toFixed(0)}G` : gib >= 1 ? `${gib.toFixed(1)}G` : `${(kib / 1024).toFixed(0)}M`
}

function formatRate (bytesPerSec) {
    const units = ['B', 'K', 'M', 'G']
    let value = bytesPerSec
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}/s`
}

function formatUptime (seconds) {
    const d = Math.floor(seconds / 86400)
    const h = Math.floor(seconds % 86400 / 3600)
    const m = Math.floor(seconds % 3600 / 60)
    return d ? `${d}d${h}h` : h ? `${h}h${m}m` : `${m}m`
}

class StatsWidget {
    constructor (terminal, source, zone) {
        this.terminal = terminal
        this.source = source
        this.zone = zone
        this.visible = false
        this.destroyed = false
        this.busy = false
        this.timer = null
        this.prev = null

        ensureStyles()
        this.el = document.createElement('div')
        this.el.className = 'tsp-bar tsp-stale'
        this.el.hidden = true
        if (readCollapsed()) {
            this.el.classList.add('tsp-collapsed')
        }
        this.el.addEventListener('click', event => {
            event.stopPropagation()
            const collapsed = this.el.classList.toggle('tsp-collapsed')
            writeCollapsed(collapsed)
        })

        const host = terminal.element.nativeElement
        if (getComputedStyle(host).position === 'static') {
            host.style.position = 'relative'
        }
        host.appendChild(this.el)
    }

    setVisible (visible) {
        this.visible = visible
        if (visible) {
            this.schedule(0)
        } else {
            clearTimeout(this.timer)
        }
    }

    schedule (delay) {
        clearTimeout(this.timer)
        if (this.destroyed || !this.visible) {
            return
        }
        // Keep the polling timer out of Angular's zone so it doesn't trigger app-wide change detection.
        this.zone.runOutsideAngular(() => {
            this.timer = setTimeout(() => this.poll(), delay)
        })
    }

    async poll () {
        if (this.busy || this.destroyed) {
            return
        }
        this.busy = true
        let delay = POLL_MS
        let target = null
        try {
            target = await this.source.current()
            if (!target) {
                this.prev = null
                if (this.source.idleMessage) {
                    this.renderMessage(null, this.source.idleMessage)
                } else {
                    this.el.hidden = true
                }
                return
            }
            const output = await target.exec(REMOTE_SCRIPT)
            if (this.destroyed) {
                return
            }
            if (output === null) {
                this.prev = null
                this.renderMessage(target, 'waiting for login')
                delay = LOGIN_WAIT_MS
                return
            }
            const fields = parseOutput(output)
            if (fields.err) {
                this.renderMessage(target, 'stats need Linux /proc')
                delay = ERROR_BACKOFF_MS * 4
            } else if (!this.render(target, fields)) {
                delay = FIRST_SAMPLE_MS
            }
        } catch (error) {
            console.warn('[tabby-server-performance]', error)
            this.renderMessage(target, describeError(error.message), error.message)
            delay = ERROR_BACKOFF_MS
        } finally {
            this.busy = false
            this.schedule(delay)
        }
    }

    renderMessage (target, message, detail) {
        const label = target?.label ?? 'ssh'
        this.el.hidden = false
        this.el.classList.add('tsp-stale')
        this.el.replaceChildren(this.dot(), this.span('tsp-host', label), this.item(null, message))
        this.el.title = detail ? `${message}: ${detail}` : message
    }

    // Returns false when this was the first sample, so the rates are still pending.
    render (target, f) {
        const now = Date.now()
        const num = (key, i = 0) => Number(f[key]?.[i] ?? NaN)

        const cpuFields = (f.cpu ?? []).slice(0, 8).map(Number)
        const cpuTotal = cpuFields.reduce((a, b) => a + b, 0)
        const cpuIdle = (cpuFields[3] ?? 0) + (cpuFields[4] ?? 0)
        const rx = num('net', 0)
        const tx = num('net', 1)

        // Rates need two samples from the same connection; a reconnect starts over.
        const prev = this.prev?.key === target.key ? this.prev : null
        this.prev = { key: target.key, cpuTotal, cpuIdle, rx, tx, time: now }

        const memTotal = num('MemTotal')
        const memAvail = Number.isFinite(num('MemAvailable'))
            ? num('MemAvailable')
            : num('MemFree') + num('Buffers') + num('Cached')
        const memUsed = memTotal - memAvail
        const memPct = memUsed / memTotal * 100
        const swapTotal = num('SwapTotal')
        const swapUsed = swapTotal - num('SwapFree')

        const diskTotal = num('disk', 0)
        const diskUsed = num('disk', 1)
        const diskAvail = num('disk', 2)
        // Same formula as df's Use%: used / (used + available).
        const diskPct = diskUsed / (diskUsed + diskAvail) * 100

        const ncpu = num('ncpu') || 1
        const load = [num('load', 0), num('load', 1), num('load', 2)]

        const items = [this.dot(), this.span('tsp-host', target.label)]

        if (prev && cpuTotal > prev.cpuTotal) {
            const cpuPct = (1 - (cpuIdle - prev.cpuIdle) / (cpuTotal - prev.cpuTotal)) * 100
            items.push(this.item('CPU', `${cpuPct.toFixed(0)}%`, severity(cpuPct, 70, 90)))
        } else {
            items.push(this.item('CPU', '...'))
        }
        items.push(this.item('load', load[0].toFixed(2), severity(load[0] / ncpu * 100, 80, 120)))
        items.push(this.item('MEM', `${formatKiB(memUsed)}/${formatKiB(memTotal)}`, severity(memPct, 80, 92)))
        items.push(this.item('DISK', `${diskPct.toFixed(0)}%`, severity(diskPct, 80, 92)))
        if (prev && now > prev.time && rx >= prev.rx && tx >= prev.tx) {
            const seconds = (now - prev.time) / 1000
            items.push(this.item('NET', `↓${formatRate((rx - prev.rx) / seconds)} ↑${formatRate((tx - prev.tx) / seconds)}`))
        }
        items.push(this.item('up', formatUptime(num('uptime'))))

        this.el.hidden = false
        this.el.classList.remove('tsp-stale')
        this.el.replaceChildren(...items)
        this.el.title = [
            `${target.label} (click to collapse/expand)`,
            `Load: ${load.map(x => x.toFixed(2)).join(' / ')} on ${ncpu} CPU${ncpu === 1 ? '' : 's'}`,
            `Memory: ${formatKiB(memUsed)} used of ${formatKiB(memTotal)} (${memPct.toFixed(0)}%)`,
            swapTotal > 0 ? `Swap: ${formatKiB(swapUsed)} used of ${formatKiB(swapTotal)}` : 'Swap: none',
            `Disk /: ${formatKiB(diskUsed)} used, ${formatKiB(diskAvail)} free of ${formatKiB(diskTotal)}`,
            `Uptime: ${formatUptime(num('uptime'))}`,
        ].join('\n')
        return prev !== null
    }

    dot () {
        return this.span('tsp-dot', '')
    }

    span (className, text) {
        const el = document.createElement('span')
        el.className = className
        el.textContent = text
        return el
    }

    item (label, value, className) {
        const el = this.span('tsp-item', '')
        if (label) {
            el.appendChild(this.span('tsp-label', label))
        }
        el.appendChild(this.span(className ?? '', value))
        return el
    }

    destroy () {
        this.destroyed = true
        clearTimeout(this.timer)
        this.el.remove()
    }
}

class ServerPerformanceDecorator extends TerminalDecorator {
    constructor (zone) {
        super()
        this.zone = zone
        this.widgets = new Map()
    }

    attach (terminal) {
        // SSHTabComponent declares `sshSession`; local shell tabs have a `session` with a
        // pty. Serial and telnet tabs get nothing.
        let source
        if ('sshSession' in terminal) {
            source = new TabbySshSource(terminal)
        } else if (process.platform !== 'win32' && 'sessionOptions' in terminal) {
            source = new LocalShellSource(terminal)
        } else {
            return
        }
        const widget = new StatsWidget(terminal, source, this.zone)
        this.widgets.set(terminal, widget)
        this.subscribeUntilDetached(terminal, terminal.visibility$.subscribe(visible => widget.setVisible(visible)))
    }

    detach (terminal) {
        this.widgets.get(terminal)?.destroy()
        this.widgets.delete(terminal)
        super.detach(terminal)
    }
}
ServerPerformanceDecorator.ctorParameters = () => [{ type: NgZone }]
Injectable()(ServerPerformanceDecorator)

class ServerPerformanceModule { }
NgModule({
    providers: [
        { provide: TerminalDecorator, useClass: ServerPerformanceDecorator, multi: true },
    ],
})(ServerPerformanceModule)

module.exports = { default: ServerPerformanceModule }
