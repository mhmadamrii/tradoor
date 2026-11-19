//go:build js

// tradoor's Lighter signer: Lighter's own signing library (github.com/elliottech/lighter-go,
// Apache-2.0) behind one function, built to WebAssembly and run in tradoor's trade worker.
//
// It signs what an order system needs and nothing more: a new API key, its registration
// (ChangePubKey, which the owner's wallet signs too), an auth token for reading the account,
// orders, grouped orders (an entry with its take profit and stop), cancels, changes and
// leverage. It has no way to sign a transfer or a withdrawal: those are simply not here.
//
// No key is kept. Each call is handed the key, makes a client for that one signature, and
// lets it go. It reaches no network: the worker fetches nonces and sends what it signs.
//
// One global, `tradoorLighter(json) -> json`: {op, ...fields} in, {txType, txInfo, txHash,
// messageToSign?} or {privateKey, publicKey} or {authToken} out, or {error}.
package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"
	"time"

	"github.com/elliottech/lighter-go/client"
	"github.com/elliottech/lighter-go/types"
	"github.com/elliottech/lighter-go/types/txtypes"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

type order struct {
	Market      int64  `json:"market"`
	ClientOrder int64  `json:"clientOrder"`
	Base        int64  `json:"base"`
	Price       uint32 `json:"price"`
	Ask         uint8  `json:"ask"`
	Type        uint8  `json:"type"`
	Tif         uint8  `json:"tif"`
	Reduce      uint8  `json:"reduce"`
	Trigger     uint32 `json:"trigger"`
	Expiry      int64  `json:"expiry"`
}

type request struct {
	Op      string `json:"op"`
	Key     string `json:"key"`
	Chain   uint32 `json:"chain"`
	Account int64  `json:"account"`
	ApiKey  uint8  `json:"apiKey"`
	Nonce   int64  `json:"nonce"`
	// auth
	Deadline int64 `json:"deadline"`
	// changePubKey
	PubKey string `json:"pubKey"`
	// order, grouped
	Order    order   `json:"order"`
	Grouping uint8   `json:"grouping"`
	Orders   []order `json:"orders"`
	// cancel, modify
	Index        int64  `json:"index"`
	Base         int64  `json:"base"`
	Price        uint32 `json:"price"`
	Trigger      uint32 `json:"trigger"`
	Market       int64  `json:"market"`
	CancelTif    uint8  `json:"cancelTif"`
	CancelTime   int64  `json:"cancelTime"`
	CancelMarket int64  `json:"cancelMarket"`
	// leverage
	Fraction   uint16 `json:"fraction"`
	MarginMode uint8  `json:"marginMode"`
}

// An order's expiry: below zero for the usual 28 days, 0 for an IOC order, which takes none.
func expiry(e int64) int64 {
	if e < 0 {
		return time.Now().Add(28 * 24 * time.Hour).UnixMilli()
	}
	return e
}

func (o order) req() *types.CreateOrderTxReq {
	return &types.CreateOrderTxReq{MarketIndex: o.Market, ClientOrderIndex: o.ClientOrder, BaseAmount: o.Base, Price: o.Price, IsAsk: o.Ask, Type: o.Type, TimeInForce: o.Tif, ReduceOnly: o.Reduce, TriggerPrice: o.Trigger, OrderExpiry: expiry(o.Expiry)}
}

type signed interface {
	GetTxType() uint8
	GetTxInfo() (string, error)
	GetTxHash() string
}

func out(tx signed, err error) (map[string]any, error) {
	if err != nil {
		return nil, err
	}
	info, err := tx.GetTxInfo()
	if err != nil {
		return nil, err
	}
	res := map[string]any{"txType": tx.GetTxType(), "txInfo": info, "txHash": tx.GetTxHash()}
	if c, ok := tx.(*txtypes.L2ChangePubKeyTxInfo); ok {
		res["messageToSign"] = c.GetL1SignatureBody()
	}
	return res, nil
}

func handle(r request) (map[string]any, error) {
	if r.Op == "generate" {
		priv, pub, err := client.GenerateAPIKey()
		if err != nil {
			return nil, err
		}
		return map[string]any{"privateKey": priv, "publicKey": pub}, nil
	}
	// A client for this one call: made from the key handed in, and let go after.
	c, err := client.NewTxClient(nil, r.Key, r.Account, r.ApiKey, r.Chain)
	if err != nil {
		return nil, err
	}
	nonce := r.Nonce
	ops := &types.TransactOpts{Nonce: &nonce, TxAttributes: &types.L2TxAttributes{}}
	switch r.Op {
	case "auth":
		deadline := r.Deadline
		if deadline <= 0 {
			deadline = time.Now().Add(7 * time.Hour).Unix()
		}
		token, err := c.GetAuthToken(time.Unix(deadline, 0))
		if err != nil {
			return nil, err
		}
		return map[string]any{"authToken": token}, nil
	case "changePubKey":
		b, err := hexutil.Decode(r.PubKey)
		if err != nil {
			return nil, err
		}
		if len(b) != 40 {
			return nil, fmt.Errorf("a public key is 40 bytes, not %d", len(b))
		}
		var pk [40]byte
		copy(pk[:], b)
		return out(c.GetChangePubKeyTransaction(&types.ChangePubKeyReq{PubKey: pk}, ops))
	case "order":
		return out(c.GetCreateOrderTransaction(r.Order.req(), ops))
	case "grouped":
		list := make([]*types.CreateOrderTxReq, len(r.Orders))
		for i, o := range r.Orders {
			list[i] = o.req()
		}
		return out(c.GetCreateGroupedOrdersTransaction(&types.CreateGroupedOrdersTxReq{GroupingType: r.Grouping, Orders: list}, ops))
	case "cancel":
		return out(c.GetCancelOrderTransaction(&types.CancelOrderTxReq{MarketIndex: r.Market, Index: r.Index}, ops))
	case "cancelAll":
		if r.CancelMarket >= 0 {
			m := r.CancelMarket
			ops.TxAttributes.CancelAllMarketIndex = &m
		}
		return out(c.GetCancelAllOrdersTransaction(&types.CancelAllOrdersTxReq{TimeInForce: r.CancelTif, Time: r.CancelTime}, ops))
	case "modify":
		return out(c.GetModifyOrderTransaction(&types.ModifyOrderTxReq{MarketIndex: r.Market, Index: r.Index, BaseAmount: r.Base, Price: r.Price, TriggerPrice: r.Trigger}, ops))
	case "leverage":
		return out(c.GetUpdateLeverageTransaction(&types.UpdateLeverageTxReq{MarketIndex: r.Market, InitialMarginFraction: r.Fraction, MarginMode: r.MarginMode}, ops))
	}
	return nil, fmt.Errorf("no such operation: %q", r.Op)
}

func main() {
	js.Global().Set("tradoorLighter", js.FuncOf(func(this js.Value, args []js.Value) (result any) {
		reply := func(v map[string]any) string {
			b, _ := json.Marshal(v)
			return string(b)
		}
		defer func() {
			if p := recover(); p != nil {
				result = reply(map[string]any{"error": fmt.Sprintf("panic: %v", p)})
			}
		}()
		if len(args) != 1 {
			return reply(map[string]any{"error": "one argument: the request as JSON"})
		}
		var r request
		if err := json.Unmarshal([]byte(args[0].String()), &r); err != nil {
			return reply(map[string]any{"error": err.Error()})
		}
		res, err := handle(r)
		if err != nil {
			return reply(map[string]any{"error": err.Error()})
		}
		return reply(res)
	}))
	select {}
}
