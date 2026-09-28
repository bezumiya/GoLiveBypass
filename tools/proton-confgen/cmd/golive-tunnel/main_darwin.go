//go:build darwin

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

const (
	defaultSocketPath    = "/var/run/golivebypass/tunnel.sock"
	configureDeadline    = 2 * time.Minute
	resolveInterval      = 60 * time.Second
	maxDynamicRoutes     = 512
	maxRequestBytes      = 64 * 1024
	logRingSize          = 120
	commandTimeout       = 10 * time.Second
	routeBinary          = "/sbin/route"
	ifconfigBinary       = "/sbin/ifconfig"
	protocolVersion      = 1
	requestReadDeadline  = 5 * time.Second
	responseWriteTimeout = 5 * time.Second
)

type request struct {
	Cmd    string `json:"cmd"`
	Config string `json:"config,omitempty"`
}

type response struct {
	OK         bool         `json:"ok"`
	Error      string       `json:"error,omitempty"`
	Protocol   int          `json:"protocol"`
	PID        int          `json:"pid"`
	Configured bool         `json:"configured"`
	Interface  string       `json:"interface,omitempty"`
	Addresses  []string     `json:"addresses,omitempty"`
	Routes     int          `json:"routes"`
	StartedAt  string       `json:"startedAt"`
	Stats      *TunnelStats `json:"stats,omitempty"`
	Logs       []string     `json:"logs,omitempty"`
}

type routeKind int

const (
	routeViaTunnel routeKind = iota
	routeReject
)

type tunnel struct {
	mu        sync.Mutex
	logMu     sync.Mutex
	logs      []string
	startedAt time.Time

	dev       *device.Device
	tun       tun.Device
	iface     string
	addresses []netip.Prefix
	endpoint  netip.AddrPort
	// routes maps each installed prefix to how it was installed: through the
	// utun, or rejected via loopback (IPv6 while the tunnel has no IPv6).
	routes     map[netip.Prefix]routeKind
	dynamic    int
	rejectFile string

	configured chan struct{}
	stop       chan struct{}
	stopOnce   sync.Once
}

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "uso: golive-tunnel serve --owner-uid <uid> [--socket <caminho>]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	socketPath := fs.String("socket", defaultSocketPath, "caminho do socket de controle")
	ownerUID := fs.Int("owner-uid", -1, "uid autorizado a controlar o túnel")
	_ = fs.Parse(os.Args[2:])

	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "golive-tunnel precisa rodar como root para criar a interface utun")
		os.Exit(1)
	}
	if *ownerUID < 0 {
		fmt.Fprintln(os.Stderr, "--owner-uid é obrigatório")
		os.Exit(2)
	}
	// O launcher sai logo depois do fork; o helper não pode morrer junto.
	signal.Ignore(syscall.SIGHUP)

	t := &tunnel{
		startedAt:  time.Now(),
		routes:     map[netip.Prefix]routeKind{},
		rejectFile: filepath.Join(filepath.Dir(*socketPath), "reject-routes"),
		configured: make(chan struct{}),
		stop:       make(chan struct{}),
	}
	if err := t.serve(*socketPath, *ownerUID); err != nil {
		t.logf("erro fatal: %v", err)
		os.Exit(1)
	}
}

func (t *tunnel) logf(format string, args ...any) {
	line := time.Now().UTC().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, line)
	t.logMu.Lock()
	t.logs = append(t.logs, line)
	if len(t.logs) > logRingSize {
		t.logs = t.logs[len(t.logs)-logRingSize:]
	}
	t.logMu.Unlock()
}

func (t *tunnel) recentLogs() []string {
	t.logMu.Lock()
	defer t.logMu.Unlock()
	return append([]string(nil), t.logs...)
}

func (t *tunnel) requestStop() {
	t.stopOnce.Do(func() { close(t.stop) })
}

// prepareSocketDir only accepts a root-owned, non-symlinked directory so an
// unprivileged process cannot redirect where root creates the socket.
func prepareSocketDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s não é um diretório comum", dir)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 {
		return fmt.Errorf("%s não pertence ao root", dir)
	}
	return os.Chmod(dir, 0o755)
}

func (t *tunnel) serve(socketPath string, ownerUID int) error {
	if err := prepareSocketDir(filepath.Dir(socketPath)); err != nil {
		return err
	}
	if c, err := net.DialTimeout("unix", socketPath, time.Second); err == nil {
		c.Close()
		return errors.New("já existe um golive-tunnel ativo")
	}
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}
	defer os.Remove(socketPath)
	if err := os.Lchown(socketPath, ownerUID, -1); err != nil {
		listener.Close()
		return err
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		listener.Close()
		return err
	}
	t.logf("helper iniciado pid=%d socket=%s", os.Getpid(), socketPath)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		select {
		case sig := <-signals:
			t.logf("sinal recebido: %v", sig)
			t.requestStop()
		case <-t.stop:
		}
	}()
	go func() {
		select {
		case <-t.configured:
		case <-t.stop:
		case <-time.After(configureDeadline):
			t.logf("nenhuma configuração recebida em %s; encerrando", configureDeadline)
			t.requestStop()
		}
	}()

	go func() {
		for {
			c, err := listener.Accept()
			if err != nil {
				select {
				case <-t.stop:
					return
				default:
				}
				t.logf("accept falhou: %v", err)
				time.Sleep(100 * time.Millisecond)
				continue
			}
			go t.handle(c.(*net.UnixConn), ownerUID)
		}
	}()

	<-t.stop
	// A GUI considera o túnel encerrado quando o socket some: só fecha o
	// listener depois que todas as rotas saíram da tabela.
	t.teardown()
	listener.Close()
	t.logf("helper encerrado")
	return nil
}

func peerUID(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return -1, err
	}
	uid := -1
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err != nil {
			credErr = err
			return
		}
		uid = int(cred.Uid)
	}); err != nil {
		return -1, err
	}
	return uid, credErr
}

func (t *tunnel) handle(c *net.UnixConn, ownerUID int) {
	defer c.Close()
	uid, err := peerUID(c)
	if err != nil || (uid != ownerUID && uid != 0) {
		t.logf("conexão recusada (uid=%d)", uid)
		return
	}
	_ = c.SetReadDeadline(time.Now().Add(requestReadDeadline))
	line, err := bufio.NewReaderSize(io.LimitReader(c, maxRequestBytes), maxRequestBytes).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return
	}
	var req request
	resp := response{}
	if err := json.Unmarshal(line, &req); err != nil {
		resp.Error = "requisição inválida"
	} else {
		switch req.Cmd {
		case "status":
			resp.OK = true
		case "configure":
			if err := t.configure(req.Config); err != nil {
				resp.Error = err.Error()
				t.logf("configure falhou: %v", err)
			} else {
				resp.OK = true
			}
		case "pause":
			if err := t.pause(); err != nil {
				resp.Error = err.Error()
			} else {
				resp.OK = true
			}
		case "stop":
			resp.OK = true
			defer t.requestStop()
		default:
			resp.Error = "comando desconhecido"
		}
	}
	t.fillStatus(&resp)
	_ = c.SetWriteDeadline(time.Now().Add(responseWriteTimeout))
	_ = json.NewEncoder(c).Encode(resp)
}

func (t *tunnel) fillStatus(resp *response) {
	resp.Protocol = protocolVersion
	resp.PID = os.Getpid()
	resp.StartedAt = t.startedAt.UTC().Format(time.RFC3339)
	resp.Logs = t.recentLogs()
	t.mu.Lock()
	defer t.mu.Unlock()
	resp.Configured = t.dev != nil
	resp.Interface = t.iface
	resp.Routes = len(t.routes)
	for _, addr := range t.addresses {
		resp.Addresses = append(resp.Addresses, addr.String())
	}
	if t.dev != nil {
		if raw, err := t.dev.IpcGet(); err == nil {
			stats := ParseIpcGet(raw, time.Now())
			resp.Stats = &stats
		}
	}
}

func run(name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", filepath.Base(name), strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func lookupHost(host string) ([]netip.Addr, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

func (t *tunnel) configure(raw string) error {
	cfg, err := ParseConfig(raw)
	if err != nil {
		return err
	}
	endpoint, err := ResolveEndpoint(cfg.Endpoint, lookupHost)
	if err != nil {
		return err
	}
	if EndpointConflict(endpoint.Addr(), discordStaticPrefixes) || EndpointConflict(endpoint.Addr(), discordSeedHosts()) {
		return errors.New("o Endpoint WireGuard fica dentro das rotas do Discord")
	}
	uapi, err := cfg.UAPI(endpoint)
	if err != nil {
		return err
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	select {
	case <-t.stop:
		return errors.New("o helper está encerrando")
	default:
	}

	first := t.dev == nil
	if first {
		tdev, err := tun.CreateTUN("utun", cfg.MTU)
		if err != nil {
			return fmt.Errorf("não consegui criar a interface utun: %w", err)
		}
		name, err := tdev.Name()
		if err != nil {
			tdev.Close()
			return err
		}
		logger := &device.Logger{
			Verbosef: func(string, ...any) {},
			Errorf:   func(format string, args ...any) { t.logf("wireguard: "+format, args...) },
		}
		t.tun = tdev
		t.iface = name
		t.dev = device.NewDevice(tdev, conn.NewDefaultBind(), logger)
	}

	if err := t.dev.IpcSet(uapi); err != nil {
		if first {
			t.closeDeviceLocked()
		}
		return fmt.Errorf("configuração WireGuard recusada: %w", err)
	}
	if first {
		if err := t.dev.Up(); err != nil {
			t.closeDeviceLocked()
			return fmt.Errorf("não consegui subir o dispositivo WireGuard: %w", err)
		}
	}
	if err := t.applyAddressesLocked(cfg.Addresses); err != nil {
		if first {
			t.closeDeviceLocked()
		}
		return err
	}
	t.endpoint = endpoint
	if first {
		for _, prefix := range append(append([]netip.Prefix(nil), discordStaticPrefixes...), discordSeedHosts()...) {
			t.addRouteLocked(prefix)
		}
		t.logf("túnel ativo em %s (endpoint %s, %d rotas)", t.iface, endpoint, len(t.routes))
		close(t.configured)
		go t.resolveLoop()
	} else {
		t.logf("perfil recarregado em %s (endpoint %s)", t.iface, endpoint)
	}
	return nil
}

// pause removes the peer but keeps the utun and its routes: Discord traffic
// is dropped instead of leaking to the normal network while the GUI measures
// Proton servers, and the next configure needs no new administrator prompt.
func (t *tunnel) pause() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.dev == nil {
		return nil
	}
	if err := t.dev.IpcSet("replace_peers=true\n"); err != nil {
		return fmt.Errorf("não consegui pausar o túnel: %w", err)
	}
	t.logf("túnel pausado em %s (sem peer)", t.iface)
	return nil
}

func (t *tunnel) applyAddressesLocked(next []netip.Prefix) error {
	wanted := map[netip.Prefix]bool{}
	for _, prefix := range next {
		wanted[prefix] = true
	}
	for _, old := range t.addresses {
		if wanted[old] {
			continue
		}
		family := "inet"
		if old.Addr().Is6() {
			family = "inet6"
		}
		if err := run(ifconfigBinary, t.iface, family, old.Addr().String(), "-alias"); err != nil {
			t.logf("remoção de endereço falhou: %v", err)
		}
	}
	current := map[netip.Prefix]bool{}
	for _, prefix := range t.addresses {
		current[prefix] = true
	}
	for _, prefix := range next {
		if current[prefix] {
			continue
		}
		var err error
		if prefix.Addr().Is4() {
			addr := prefix.Addr().String()
			err = run(ifconfigBinary, t.iface, "inet", addr, addr, "alias")
		} else {
			err = run(ifconfigBinary, t.iface, "inet6", prefix.Addr().String(), "prefixlen", "128", "alias")
		}
		if err != nil {
			return fmt.Errorf("não consegui configurar o endereço do túnel: %w", err)
		}
	}
	if err := run(ifconfigBinary, t.iface, "up"); err != nil {
		return err
	}
	t.addresses = append([]netip.Prefix(nil), next...)
	return nil
}

func (t *tunnel) hasIPv6Locked() bool {
	for _, prefix := range t.addresses {
		if prefix.Addr().Is6() {
			return true
		}
	}
	return false
}

func (t *tunnel) addRouteLocked(prefix netip.Prefix) bool {
	prefix = prefix.Masked()
	if _, ok := t.routes[prefix]; ok {
		return false
	}
	family := "-inet"
	if prefix.Addr().Is6() {
		family = "-inet6"
	}
	kind := routeViaTunnel
	args := []string{"-q", "-n", "add", family, prefix.String(), "-interface", t.iface}
	// Sem IPv6 no túnel, `-interface utunN` é aceito pelo route(8) mas não
	// entra na tabela, e o destino IPv6 do Discord sairia pela rede normal.
	// A rota de rejeição via loopback recusa a conexão na hora e o Chromium
	// cai para IPv4, que passa pelo túnel.
	if prefix.Addr().Is6() && !t.hasIPv6Locked() {
		kind = routeReject
		args = []string{"-q", "-n", "add", family, prefix.String(), "::1", "-reject"}
	}
	if kind == routeReject {
		// Uma rota de rejeição via loopback igual só pode ser resto de um
		// helper que morreu sem limpar: remove antes para o add não falhar.
		_ = run(routeBinary, "-q", "-n", "delete", family, prefix.String(), "::1")
	}
	if err := run(routeBinary, args...); err != nil {
		t.logf("rota %s não instalada: %v", prefix, err)
		return false
	}
	if !t.routeInstalledLocked(prefix, kind) {
		t.logf("rota %s aceita pelo route(8) mas ausente da tabela", prefix)
		return false
	}
	t.routes[prefix] = kind
	if kind == routeReject {
		t.persistRejectRoutesLocked()
	}
	return true
}

// routeInstalledLocked asks the kernel which interface would carry the first
// address of the prefix, so a silently ignored `route add` is caught.
func (t *tunnel) routeInstalledLocked(prefix netip.Prefix, kind routeKind) bool {
	family := "-inet"
	if prefix.Addr().Is6() {
		family = "-inet6"
	}
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	// O endereço de rede de um prefixo IPv6 não casa com a própria rota no
	// route get (cai na default); um endereço interno casa.
	probe := prefix.Addr()
	if prefix.Bits() < probe.BitLen() {
		probe = probe.Next()
	}
	out, err := exec.CommandContext(ctx, routeBinary, "-n", "get", family, probe.String()).Output()
	if err != nil {
		return false
	}
	iface, flags := "", ""
	for _, line := range strings.Split(string(out), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		switch key {
		case "interface":
			iface = strings.TrimSpace(value)
		case "flags":
			flags = value
		}
	}
	if kind == routeReject {
		return strings.Contains(flags, "REJECT")
	}
	return iface == t.iface
}

// persistRejectRoutesLocked records loopback reject routes: unlike the utun
// routes they survive a crash of the helper, so the GUI's forced stop needs
// the list to remove them.
func (t *tunnel) persistRejectRoutesLocked() {
	var lines []string
	for prefix, kind := range t.routes {
		if kind == routeReject {
			lines = append(lines, prefix.String())
		}
	}
	if err := os.WriteFile(t.rejectFile, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.logf("não consegui registrar as rotas de rejeição: %v", err)
	}
}

func (t *tunnel) resolveLoop() {
	ticker := time.NewTicker(resolveInterval)
	defer ticker.Stop()
	for {
		t.resolveOnce()
		select {
		case <-t.stop:
			return
		case <-ticker.C:
		}
	}
}

func (t *tunnel) resolveOnce() {
	var found []netip.Prefix
	for _, host := range discordHostnames {
		addrs, err := lookupHost(host)
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			addr = addr.Unmap()
			if AcceptResolvedAddress(addr) {
				found = append(found, netip.PrefixFrom(addr, addr.BitLen()))
			}
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.dev == nil {
		return
	}
	added := 0
	for _, prefix := range found {
		if t.dynamic >= maxDynamicRoutes {
			break
		}
		covered := false
		for existing := range t.routes {
			if existing.Bits() < prefix.Bits() && existing.Contains(prefix.Addr()) {
				covered = true
				break
			}
		}
		if covered || prefix.Addr() == t.endpoint.Addr() {
			continue
		}
		if t.addRouteLocked(prefix) {
			t.dynamic++
			added++
		}
	}
	if added > 0 {
		t.logf("DNS do Discord: %d rotas novas (%d no total)", added, len(t.routes))
	}
}

func (t *tunnel) closeDeviceLocked() {
	if t.dev != nil {
		t.dev.Close()
	} else if t.tun != nil {
		t.tun.Close()
	}
	t.dev = nil
	t.tun = nil
	t.iface = ""
	t.addresses = nil
}

func (t *tunnel) teardown() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for prefix, kind := range t.routes {
		family := "-inet"
		if prefix.Addr().Is6() {
			family = "-inet6"
		}
		if kind == routeReject {
			_ = run(routeBinary, "-q", "-n", "delete", family, prefix.String(), "::1")
			continue
		}
		// Rotas -interface somem junto com a utun; o delete explícito só
		// garante que nada fique para trás se o kernel mantiver alguma.
		_ = run(routeBinary, "-q", "-n", "delete", family, prefix.String(), "-interface", t.iface)
	}
	t.routes = map[netip.Prefix]routeKind{}
	_ = os.Remove(t.rejectFile)
	t.closeDeviceLocked()
}
