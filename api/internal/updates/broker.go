package updates

import (
	"errors"
	"sync"
	"time"
)

const (
	MaxConnections        = 100
	MaxConnectionsPerIP   = 2
	maxRememberedDelivery = 1024
	deliveryRetention     = 24 * time.Hour
)

var ErrTooManyConnections = errors.New("limite de conexoes de atualizacao excedido")

// ReleaseEvent e deliberadamente pequeno: ele acorda o updater, mas nao e a
// fonte de verdade do arquivo nem do digest. O cliente sempre confirma a
// release diretamente no GitHub antes de baixar.
type ReleaseEvent struct {
	DeliveryID  string `json:"-"`
	Tag         string `json:"tag"`
	Prerelease  bool   `json:"prerelease"`
	PublishedAt string `json:"published_at,omitempty"`
}

type client struct {
	id     uint64
	ip     string
	events chan ReleaseEvent
}

type Subscription struct {
	broker *Broker
	client *client
	once   sync.Once
}

func (s *Subscription) Events() <-chan ReleaseEvent {
	return s.client.events
}

func (s *Subscription) Close() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		s.broker.remove(s.client)
	})
}

// Broker e intencionalmente em memoria. Se ele reiniciar, a GUI ainda faz a
// consulta ao GitHub no boot e no fallback horario; perder o pulso nao perde a
// atualizacao.
type Broker struct {
	mu         sync.Mutex
	nextID     uint64
	clients    map[uint64]*client
	latest     *ReleaseEvent
	seen       map[string]time.Time
	maxClients int
	maxPerIP   int
}

func NewBroker() *Broker {
	return &Broker{
		clients:    make(map[uint64]*client),
		seen:       make(map[string]time.Time),
		maxClients: MaxConnections,
		maxPerIP:   MaxConnectionsPerIP,
	}
}

func (b *Broker) Subscribe(ip string) (*Subscription, *ReleaseEvent, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if ip == "" {
		ip = "unknown"
	}
	if len(b.clients) >= b.maxClients {
		return nil, nil, ErrTooManyConnections
	}
	perIP := 0
	for _, c := range b.clients {
		if c.ip == ip {
			perIP++
		}
	}
	if perIP >= b.maxPerIP {
		return nil, nil, ErrTooManyConnections
	}

	b.nextID++
	c := &client{id: b.nextID, ip: ip, events: make(chan ReleaseEvent, 2)}
	b.clients[c.id] = c
	var latest *ReleaseEvent
	if b.latest != nil {
		copy := *b.latest
		latest = &copy
	}
	return &Subscription{broker: b, client: c}, latest, nil
}

// Publish retorna false quando o delivery ja foi processado. Eventos novos
// substituem o pulso pendente de um cliente lento, em vez de travar o webhook.
func (b *Broker) Publish(deliveryID string, event ReleaseEvent) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	b.pruneSeen(now)
	if _, ok := b.seen[deliveryID]; ok {
		return false
	}
	// O polling usa um delivery proprio. Se o webhook chegar tambem, o mesmo
	// release nao deve acordar cada cliente duas vezes.
	if b.latest != nil && b.latest.Tag == event.Tag && b.latest.PublishedAt == event.PublishedAt {
		return false
	}
	b.seen[deliveryID] = now
	if len(b.seen) > maxRememberedDelivery {
		b.pruneOldest()
	}

	event.DeliveryID = deliveryID
	copy := event
	b.latest = &copy
	for _, c := range b.clients {
		select {
		case c.events <- event:
		default:
			// A fila so precisa conter o pulso mais recente. Se o cliente
			// estiver lento, descarta o antigo e tenta substitui-lo.
			select {
			case <-c.events:
			default:
			}
			select {
			case c.events <- event:
			default:
			}
		}
	}
	return true
}

func (b *Broker) remove(c *client) {
	b.mu.Lock()
	delete(b.clients, c.id)
	b.mu.Unlock()
}

func (b *Broker) pruneSeen(now time.Time) {
	cutoff := now.Add(-deliveryRetention)
	for id, seenAt := range b.seen {
		if seenAt.Before(cutoff) {
			delete(b.seen, id)
		}
	}
}

func (b *Broker) pruneOldest() {
	for len(b.seen) > maxRememberedDelivery {
		var oldestID string
		var oldest time.Time
		for id, seenAt := range b.seen {
			if oldestID == "" || seenAt.Before(oldest) {
				oldestID = id
				oldest = seenAt
			}
		}
		if oldestID == "" {
			return
		}
		delete(b.seen, oldestID)
	}
}
