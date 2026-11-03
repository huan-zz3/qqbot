package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
	"testing/iotest"
)

func TestWriteReadFrames(t *testing.T) {
	var buf bytes.Buffer
	payloads := [][]byte{[]byte("first"), []byte(""), []byte("third payload")}
	for _, p := range payloads[:1] {
		if err := writeFrame(&buf, p); err != nil {
			t.Fatalf("writeFrame: %v", err)
		}
	}
	if err := writeFrame(&buf, payloads[2]); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}

	got, err := readFrame(&buf)
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if !bytes.Equal(got, payloads[0]) {
		t.Fatalf("第一帧不符：%q", got)
	}
	got, err = readFrame(&buf)
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if !bytes.Equal(got, payloads[2]) {
		t.Fatalf("第二帧不符：%q", got)
	}
	if _, err := readFrame(&buf); !errors.Is(err, io.EOF) {
		t.Fatalf("读尽后应返回 EOF，实际 %v", err)
	}
}

// 粘包：两帧一次写入，连续读出。
func TestReadFramesSticky(t *testing.T) {
	var buf bytes.Buffer
	writeFrame(&buf, []byte(`{"a":1}`))
	writeFrame(&buf, []byte(`{"b":2}`))

	for _, want := range []string{`{"a":1}`, `{"b":2}`} {
		got, err := readFrame(&buf)
		if err != nil {
			t.Fatalf("readFrame: %v", err)
		}
		if string(got) != want {
			t.Fatalf("帧内容不符：got %q want %q", got, want)
		}
	}
}

// 半包：每次只给 1 字节，帧头与载荷都必须被重新拼起来。
func TestReadFramesOneByteAtATime(t *testing.T) {
	var buf bytes.Buffer
	want := bytes.Repeat([]byte("半包"), 64)
	if err := writeFrame(&buf, want); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}
	got, err := readFrame(iotest.OneByteReader(&buf))
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("载荷不符（%d vs %d 字节）", len(got), len(want))
	}
}

func TestReadFrameOversizeIsProtocolError(t *testing.T) {
	var buf bytes.Buffer
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], maxFrameLen+1)
	buf.Write(header[:])

	_, err := readFrame(&buf)
	var pe *protocolError
	if !errors.As(err, &pe) {
		t.Fatalf("超大帧应返回 protocolError，实际 %v", err)
	}
}

func TestReadFrameZeroLengthIsProtocolError(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 0, 0})
	_, err := readFrame(&buf)
	var pe *protocolError
	if !errors.As(err, &pe) {
		t.Fatalf("零长度帧应返回 protocolError，实际 %v", err)
	}
}

func TestReadFrameShortBody(t *testing.T) {
	var buf bytes.Buffer
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], 10)
	buf.Write(header[:])
	buf.Write([]byte("abc"))

	if _, err := readFrame(&buf); err == nil {
		t.Fatal("载荷不完整应当报错")
	}
}

func TestReadFrameShortHeader(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0, 0})
	if _, err := readFrame(&buf); err == nil {
		t.Fatal("帧头不完整应当报错")
	}
}

func TestWriteFrameRejectsEmptyAndOversize(t *testing.T) {
	var buf bytes.Buffer
	if err := writeFrame(&buf, nil); err == nil {
		t.Fatal("空载荷应当报错")
	}
	if err := writeFrame(&buf, make([]byte, maxFrameLen+1)); err == nil {
		t.Fatal("超大载荷应当报错")
	}
}
