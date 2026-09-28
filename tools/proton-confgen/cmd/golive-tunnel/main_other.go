//go:build !darwin

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "golive-tunnel só é usado no macOS; Windows usa WireSock e Linux usa network namespace")
	os.Exit(1)
}
