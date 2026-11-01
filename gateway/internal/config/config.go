// Package config loads gateway.yaml.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Token struct {
	Name        string `yaml:"name"`
	Token       string `yaml:"token"`
	MaxStreams  int    `yaml:"max_streams"`
	MaxSessions int    `yaml:"max_sessions"`
}

type Store struct {
	RetentionSec      int   `yaml:"retention_sec"`
	ThinAfterSec      int   `yaml:"thin_after_sec"`
	ThinnedIntervalMs int   `yaml:"thinned_interval_ms"`
	MaxBytes          int64 `yaml:"max_bytes"`
}

type Config struct {
	Listen         string   `yaml:"listen"`
	AgentURL       string   `yaml:"agent_url"`
	InternalToken  string   `yaml:"internal_token"`
	MediaRoot      string   `yaml:"media_root"`
	AllowedSchemes []string `yaml:"allowed_schemes"`
	AllowedHosts   []string `yaml:"allowed_hosts"`
	Tokens         []Token  `yaml:"tokens"`
	Store          Store    `yaml:"store"`
	LogLevel       string   `yaml:"log_level"`
}

// Default returns a config with safe defaults (loopback listen, no tokens).
func Default() Config {
	return Config{
		Listen:         "127.0.0.1:8080",
		AgentURL:       "http://127.0.0.1:8090",
		MediaRoot:      "./media",
		AllowedSchemes: []string{"file", "device", "rtsp", "http", "https"},
		Store:          Store{RetentionSec: 3600, ThinAfterSec: 300, ThinnedIntervalMs: 1000, MaxBytes: 2 << 30},
		LogLevel:       "info",
	}
}

// Load reads path (YAML) over defaults. Empty path returns defaults.
func Load(path string) (Config, error) {
	c := Default()
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return c, err
		}
		if err := yaml.Unmarshal(b, &c); err != nil {
			return c, fmt.Errorf("parse %s: %w", path, err)
		}
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	if c.InternalToken == "" {
		return fmt.Errorf("internal_token must be set")
	}
	if len(c.Tokens) == 0 {
		return fmt.Errorf("at least one token must be configured")
	}
	for i, t := range c.Tokens {
		if len(t.Token) < 8 {
			return fmt.Errorf("tokens[%d]: token must be at least 8 chars", i)
		}
	}
	return nil
}
