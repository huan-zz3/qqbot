package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// batchProbe 用一个可控时钟替换真实时间，并记录每项收到的参数。
// 预算与超时都用注入的执行器验证，发行版里不留测试钩子。
type batchProbe struct {
	clock   time.Time
	pshIn   []pshArgs
	readIn  []readArgs
	pshFunc func(pshArgs) (pshResult, error)
	readFn  func(readArgs) (readResult, error)
}

func newBatchProbe(start time.Time) *batchProbe {
	return &batchProbe{clock: start}
}

func (p *batchProbe) runner() batchRunner {
	return batchRunner{
		psh: func(args pshArgs) (pshResult, error) {
			p.pshIn = append(p.pshIn, args)
			if p.pshFunc != nil {
				return p.pshFunc(args)
			}
			return pshResult{}, nil
		},
		read: func(args readArgs) (readResult, error) {
			p.readIn = append(p.readIn, args)
			if p.readFn != nil {
				return p.readFn(args)
			}
			return readResult{Encoding: "utf-8"}, nil
		},
		now: func() time.Time { return p.clock },
	}
}

func (p *batchProbe) advance(d time.Duration) { p.clock = p.clock.Add(d) }

func silentUI() *ui { return &ui{w: io.Discard} }

func TestHandleBatchKeepsOrderAndResultShapes(t *testing.T) {
	start := time.Date(2026, 11, 4, 14, 22, 31, 0, time.UTC)
	probe := newBatchProbe(start)
	probe.pshFunc = func(args pshArgs) (pshResult, error) {
		return pshResult{Exit: 0, Stdout: "ok\n"}, nil
	}
	probe.readFn = func(args readArgs) (readResult, error) {
		return readResult{Text: "日志", Bytes: 6, Encoding: "utf-16le"}, nil
	}

	args := batchArgs{
		Items: []batchItem{
			{Type: "psh", Command: "Get-Process", TimeoutMS: 30000},
			{Type: "read", Path: `C:\a.log`, MaxBytes: 4096},
		},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	}
	result := handleBatch(silentUI(), args, start, probe.runner())

	if len(result.Items) != 2 {
		t.Fatalf("项数不符：%d", len(result.Items))
	}
	if len(probe.pshIn) != 1 || probe.pshIn[0].Command != "Get-Process" {
		t.Fatalf("psh 没有按序执行：%+v", probe.pshIn)
	}
	if len(probe.readIn) != 1 || probe.readIn[0].Path != `C:\a.log` || probe.readIn[0].MaxBytes != 4096 {
		t.Fatalf("read 参数不符：%+v", probe.readIn)
	}
	// 顺序即结果顺序：第 1 项必须是 psh 的形状，第 2 项是 read 的形状。
	if _, ok := result.Items[0].Result.(pshResult); !ok {
		t.Fatalf("第 1 项不是 psh 结果：%T", result.Items[0].Result)
	}
	if _, ok := result.Items[1].Result.(readResult); !ok {
		t.Fatalf("第 2 项不是 read 结果：%T", result.Items[1].Result)
	}
	if !result.Items[0].OK || !result.Items[1].OK {
		t.Fatalf("两项都应成功：%+v", result.Items)
	}
}

func TestHandleBatchContinuesAfterItemFailure(t *testing.T) {
	start := time.Now()
	probe := newBatchProbe(start)
	probe.pshFunc = func(args pshArgs) (pshResult, error) {
		return pshResult{}, errors.New("无法启动 powershell")
	}

	args := batchArgs{
		Items: []batchItem{
			{Type: "psh", Command: "Get-Service"},
			{Type: "read", Path: `C:\b.log`},
		},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	}
	result := handleBatch(silentUI(), args, start, probe.runner())

	if len(result.Items) != 2 {
		t.Fatalf("项数不符：%d", len(result.Items))
	}
	if result.Items[0].OK || result.Items[0].Error == "" || result.Items[0].Result != nil {
		t.Fatalf("失败项只应带 error：%+v", result.Items[0])
	}
	if !result.Items[1].OK {
		t.Fatalf("失败后必须继续执行后续项：%+v", result.Items[1])
	}
	if len(probe.readIn) != 1 {
		t.Fatalf("后续项没有被执行：%+v", probe.readIn)
	}
}

func TestHandleBatchBudgetExhausted(t *testing.T) {
	start := time.Now()
	probe := newBatchProbe(start)
	probe.pshFunc = func(args pshArgs) (pshResult, error) {
		probe.advance(30 * time.Second)
		return pshResult{Exit: 0}, nil
	}

	args := batchArgs{
		Items: []batchItem{
			{Type: "psh", Command: "a"},
			{Type: "psh", Command: "b"},
			{Type: "psh", Command: "c"},
		},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	}
	result := handleBatch(silentUI(), args, start, probe.runner())

	if len(result.Items) != 3 {
		t.Fatalf("未执行项也必须占位：%d", len(result.Items))
	}
	if !result.Items[0].OK || !result.Items[1].OK {
		t.Fatalf("前两项应在预算内跑完：%+v", result.Items)
	}
	last := result.Items[2]
	if last.OK || last.Error != "未执行（批次预算耗尽）" {
		t.Fatalf("第三项应标未执行：%+v", last)
	}
	if len(probe.pshIn) != 2 {
		t.Fatalf("预算耗尽后不应再启动：%d", len(probe.pshIn))
	}
}

func TestHandleBatchBudgetExhaustedBeforeFirstItem(t *testing.T) {
	start := time.Now()
	probe := newBatchProbe(start)
	// 帧在队列里等了 55 秒，预算只剩 4 秒：一条都装不下 taskkill 宽限。
	probe.advance(55 * time.Second)

	args := batchArgs{
		Items:         []batchItem{{Type: "psh", Command: "a"}, {Type: "read", Path: `C:\a.log`}},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	}
	result := handleBatch(silentUI(), args, start, probe.runner())

	for _, item := range result.Items {
		if item.OK || item.Error != "未执行（批次预算耗尽）" {
			t.Fatalf("全部项都应标未执行：%+v", result.Items)
		}
	}
	if len(probe.pshIn) != 0 || len(probe.readIn) != 0 {
		t.Fatalf("预算已耗尽却执行了：psh=%d read=%d", len(probe.pshIn), len(probe.readIn))
	}
}

func TestHandleBatchOutputLimit(t *testing.T) {
	start := time.Now()
	probe := newBatchProbe(start)
	probe.pshFunc = func(args pshArgs) (pshResult, error) {
		return pshResult{Stdout: strings.Repeat("字", 40)}, nil
	}

	args := batchArgs{
		Items: []batchItem{
			{Type: "psh", Command: "a"},
			{Type: "psh", Command: "b"},
			{Type: "psh", Command: "c"},
			{Type: "psh", Command: "d"},
		},
		BudgetMS:      59000,
		MaxTotalChars: 100,
	}
	result := handleBatch(silentUI(), args, start, probe.runner())

	// 40 + 40 + 40 在第三项到顶：前三项都展示，第四项未展示。
	if !result.Items[0].OK || !result.Items[1].OK || !result.Items[2].OK {
		t.Fatalf("到顶前的项都应执行：%+v", result.Items)
	}
	if len(result.Items) != 4 {
		t.Fatalf("未展示项也必须占位：%d", len(result.Items))
	}
	if result.Items[3].OK || result.Items[3].Error != "未展示（整批输出超限）" {
		t.Fatalf("超限后应标未展示：%+v", result.Items[3])
	}
	if len(probe.pshIn) != 3 {
		t.Fatalf("到顶后不应再执行：%d", len(probe.pshIn))
	}
}

func TestHandleBatchUnknownTypeAndMissingFields(t *testing.T) {
	start := time.Now()
	probe := newBatchProbe(start)

	args := batchArgs{
		Items: []batchItem{
			{Type: "reboot"},
			{},
			{Type: "psh"},
			{Type: "read"},
			{Type: "psh", Command: "Get-Date"},
		},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	}
	result := handleBatch(silentUI(), args, start, probe.runner())

	if len(result.Items) != 5 {
		t.Fatalf("项数不符：%d", len(result.Items))
	}
	if result.Items[0].OK || !strings.Contains(result.Items[0].Error, "未知指令类型：reboot") {
		t.Fatalf("未知类型应失败且说明原因：%+v", result.Items[0])
	}
	if result.Items[1].OK || !strings.Contains(result.Items[1].Error, "未知指令类型") {
		t.Fatalf("缺 type 应失败：%+v", result.Items[1])
	}
	if result.Items[2].OK || result.Items[2].Error != "command 为空" {
		t.Fatalf("psh 缺 command 应失败：%+v", result.Items[2])
	}
	if result.Items[3].OK || result.Items[3].Error != "path 为空" {
		t.Fatalf("read 缺 path 应失败：%+v", result.Items[3])
	}
	if !result.Items[4].OK {
		t.Fatalf("畸形项不应污染其余项：%+v", result.Items[4])
	}
	if len(probe.pshIn) != 1 {
		t.Fatalf("只有最后一项该真正执行：%+v", probe.pshIn)
	}
}

func TestHandleBatchSixteenItems(t *testing.T) {
	start := time.Now()
	probe := newBatchProbe(start)
	items := make([]batchItem, 16)
	for i := range items {
		items[i] = batchItem{Type: "psh", Command: "op"}
	}
	args := batchArgs{Items: items, BudgetMS: 59000, MaxTotalChars: 80000}

	result := handleBatch(silentUI(), args, start, probe.runner())

	if len(result.Items) != 16 {
		t.Fatalf("16 项应全部占位：%d", len(result.Items))
	}
	for i, item := range result.Items {
		if !item.OK {
			t.Fatalf("第 %d 项不应失败：%+v", i+1, item)
		}
	}
}

func TestHandleBatchAppliesBudgetToItemTimeout(t *testing.T) {
	start := time.Now()
	probe := newBatchProbe(start)

	args := batchArgs{
		Items: []batchItem{
			{Type: "psh", Command: "a", TimeoutMS: 30000},
			{Type: "psh", Command: "b"},
		},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	}
	handleBatch(silentUI(), args, start, probe.runner())

	if len(probe.pshIn) != 2 {
		t.Fatalf("应执行两项：%d", len(probe.pshIn))
	}
	if probe.pshIn[0].TimeoutMS != 30000 {
		t.Fatalf("下发值更小时应保留下发值：%d", probe.pshIn[0].TimeoutMS)
	}
	// 缺省值取本地 60s 上限，但仍须扣掉 killGrace：59000-5000=54000。
	if probe.pshIn[1].TimeoutMS != 54000 {
		t.Fatalf("缺省超时未按剩余预算收敛：%d", probe.pshIn[1].TimeoutMS)
	}
}

func TestBatchItemTimeout(t *testing.T) {
	cases := []struct {
		name      string
		requested int
		remaining time.Duration
		want      int
	}{
		{"下发值更小", 30000, 59 * time.Second, 30000},
		{"缺省用本地上限", 0, 59 * time.Second, 54000},
		{"下发值超过本地上限", 100000, 59 * time.Second, 54000},
		{"剩余预算收紧", 30000, 8 * time.Second, 3000},
		{"不低于一秒", 30000, 5001 * time.Millisecond, 1000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := batchItemTimeout(c.requested, c.remaining); got != c.want {
				t.Fatalf("batchItemTimeout(%d, %s) = %d，want %d", c.requested, c.remaining, got, c.want)
			}
		})
	}
}

func TestHandleToolRunBatch(t *testing.T) {
	content := "2026-11-04 启动成功\n"
	path := writeTempFile(t, []byte(content))
	u := &ui{w: io.Discard}

	args, err := json.Marshal(batchArgs{
		Items:         []batchItem{{Type: "read", Path: path}},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	res := handleTool(u, request{ID: "batch-1", Tool: "run_batch", Args: args})
	if !res.OK || res.ID != "batch-1" {
		t.Fatalf("回包不符：%+v", res)
	}
	result, ok := res.Result.(batchResult)
	if !ok {
		t.Fatalf("result 类型不符：%T", res.Result)
	}
	if len(result.Items) != 1 || !result.Items[0].OK {
		t.Fatalf("项结果不符：%+v", result.Items)
	}
	read, ok := result.Items[0].Result.(readResult)
	if !ok || read.Text != content {
		t.Fatalf("文件正文不符：%+v", result.Items[0].Result)
	}
}

func TestHandleToolRunBatchEmptyItems(t *testing.T) {
	u := &ui{w: io.Discard}
	args, _ := json.Marshal(batchArgs{Items: []batchItem{}})
	res := handleTool(u, request{ID: "batch-2", Tool: "run_batch", Args: args})
	if res.OK || !strings.Contains(res.Error, "items 为空") {
		t.Fatalf("空 items 应回 ok:false：%+v", res)
	}
}

func TestHandleToolRunBatchBadArgs(t *testing.T) {
	u := &ui{w: io.Discard}
	res := handleTool(u, request{ID: "batch-3", Tool: "run_batch", Args: json.RawMessage(`"not an object"`)})
	if res.OK || res.Error == "" {
		t.Fatalf("参数非法时应回 ok:false：%+v", res)
	}
}

func TestBatchResultJSONShape(t *testing.T) {
	body, err := json.Marshal(batchResult{Items: []batchOutcome{
		{OK: true, Result: pshResult{Exit: 0}},
		{Error: `文件不存在：C:\x.log`},
	}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"items":[{"ok":true,"result":{"exit":0,"stdout":"","stderr":"","timedOut":false,"truncated":false}},` +
		`{"ok":false,"error":"文件不存在：C:\\x.log"}]}`
	if string(body) != want {
		t.Fatalf("批量回包形状不符：\n got %s\nwant %s", body, want)
	}
}

func TestBatchWindowIndexed(t *testing.T) {
	var buf bytes.Buffer
	u := &ui{w: &buf}
	u.batchStart(2)
	args := batchArgs{
		Items: []batchItem{
			{Type: "psh", Command: "Get-Process"},
			{Type: "psh", Command: "Get-Service"},
		},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	}
	handleBatch(u, args, time.Now(), newBatchProbe(time.Now()).runner())

	out := buf.String()
	for _, want := range []string{"批次：2 条", "[1/2]", "[2/2]", "Get-Process", "Get-Service"} {
		if !strings.Contains(out, want) {
			t.Fatalf("窗口输出缺少 %q：\n%s", want, out)
		}
	}
}

func TestBatchReadMissingFileIsReportedNotSkipped(t *testing.T) {
	start := time.Now()
	probe := newBatchProbe(start)
	probe.readFn = readFile

	args := batchArgs{
		Items:         []batchItem{{Type: "read", Path: filepath.Join(t.TempDir(), "gone.log")}},
		BudgetMS:      59000,
		MaxTotalChars: 80000,
	}
	result := handleBatch(silentUI(), args, start, probe.runner())

	if result.Items[0].OK || !strings.Contains(result.Items[0].Error, "文件不存在") {
		t.Fatalf("文件不存在必须如实回报：%+v", result.Items[0])
	}
}
