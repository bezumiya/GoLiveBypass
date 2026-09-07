// Package speedtest measures HTTPS transfers through isolated userspace
// WireGuard tunnels. It never installs a host interface or a system route.
package speedtest

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/constants"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

func keyHex(value string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return "", errors.New("chave WireGuard inválida")
	}
	return hex.EncodeToString(decoded), nil
}

func tunnelClient(privateKey string, peer api.PhysicalServer) (*http.Client, func(), error) {
	return tunnelClientPort(privateKey, peer, constants.WireGuardPort)
}

func tunnelClientPort(privateKey string, peer api.PhysicalServer, port int) (*http.Client, func(), error) {
	private, err := keyHex(privateKey)
	if err != nil {
		return nil, nil, err
	}
	public, err := keyHex(strings.TrimSpace(peer.X25519PublicKey))
	if err != nil {
		return nil, nil, err
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(peer.EntryIP))
	if err != nil {
		return nil, nil, errors.New("IP de entrada inválido")
	}
	tun, tnet, err := netstack.CreateNetTUN(
		[]netip.Addr{netip.MustParsePrefix(constants.WireGuardIPv4).Addr()},
		[]netip.Addr{netip.MustParseAddr(constants.DefaultDNSIPv4)}, 1280,
	)
	if err != nil {
		return nil, nil, errors.New("não foi possível criar o túnel de medição")
	}
	dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	uapi := fmt.Sprintf("private_key=%s\npublic_key=%s\nallowed_ip=0.0.0.0/0\nendpoint=%s\n", private, public, net.JoinHostPort(ip.String(), strconv.Itoa(port)))
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return nil, nil, errors.New("falha ao configurar túnel de medição")
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, nil, errors.New("falha ao iniciar túnel de medição")
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			return tnet.DialContext(ctx, "tcp4", address)
		},
		TLSHandshakeTimeout: 4 * time.Second,
		DisableCompression:  true,
		ForceAttemptHTTP2:   true,
	}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirecionamento recusado") }}
	return client, func() { transport.CloseIdleConnections(); dev.Close() }, nil
}
