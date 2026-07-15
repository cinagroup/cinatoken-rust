package service

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/cinagroup/cinatoken/common"
	"github.com/cinagroup/cinatoken/dto"
	relaycommon "github.com/cinagroup/cinatoken/relay/common"
	"github.com/cinagroup/cinatoken/setting/ratio_setting"
	"github.com/cinagroup/cinatoken/types"
	"github.com/gin-gonic/gin"
)

type flatManifestUsage struct {
	PromptTokens              int    `json:"prompt_tokens"`
	CompletionTokens          int    `json:"completion_tokens"`
	TotalTokens               int    `json:"total_tokens"`
	CachedTokens              int    `json:"cached_tokens"`
	CacheCreationTokens       int    `json:"cache_creation_tokens"`
	CacheCreation5mTokens     int    `json:"cache_creation_5m_tokens"`
	CacheCreation1hTokens     int    `json:"cache_creation_1h_tokens"`
	ImageTokens               int    `json:"image_tokens"`
	AudioInputTokens          int    `json:"audio_input_tokens"`
	AudioOutputTokens         int    `json:"audio_output_tokens"`
	WebSearchPreviewCalls     int    `json:"web_search_preview_calls"`
	WebSearchCalls            int    `json:"web_search_calls"`
	FileSearchCalls           int    `json:"file_search_calls"`
	ImageGenerationPriceClass string `json:"image_generation_price_class,omitempty"`
	AnthropicSemantic         bool   `json:"is_anthropic_usage_semantic"`
}

type flatManifestSnapshot struct {
	Mode                      string   `json:"mode"`
	ModelRatio                float64  `json:"model_ratio"`
	CompletionRatio           float64  `json:"completion_ratio"`
	GroupRatio                float64  `json:"group_ratio"`
	CacheRatio                float64  `json:"cache_ratio"`
	CacheCreationRatio        float64  `json:"cache_creation_ratio"`
	CacheCreationRatio5m      float64  `json:"cache_creation_ratio_5m"`
	CacheCreationRatio1h      float64  `json:"cache_creation_ratio_1h"`
	ImageRatio                float64  `json:"image_ratio"`
	AudioRatio                float64  `json:"audio_ratio"`
	AudioCompletionRatio      float64  `json:"audio_completion_ratio"`
	UsesAudioDetailBilling    bool     `json:"uses_audio_detail_billing"`
	AudioInputPricePerMillion float64  `json:"audio_input_price_per_million"`
	QuotaPerUnit              float64  `json:"quota_per_unit"`
	ModelPrice                *float64 `json:"model_price"`
	ImagePriceRatio           float64  `json:"image_price_ratio"`
	OtherRatioProduct         float64  `json:"other_ratio_product"`
}

type flatManifestTerminalCase struct {
	Name          string               `json:"name"`
	Kind          string               `json:"kind"`
	Model         string               `json:"model"`
	Snapshot      flatManifestSnapshot `json:"snapshot"`
	Usage         flatManifestUsage    `json:"usage"`
	ExpectedQuota int                  `json:"expected_quota"`
}

func floatPointer(value float64) *float64 { return &value }

func manifestContext() *gin.Context {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	return context
}

func textManifestCase(
	name string,
	model string,
	priceData types.PriceData,
	usage dto.Usage,
	configure func(*gin.Context, *relaycommon.RelayInfo),
	manifestUsage flatManifestUsage,
	snapshot flatManifestSnapshot,
) flatManifestTerminalCase {
	context := manifestContext()
	info := &relaycommon.RelayInfo{
		OriginModelName: model,
		StartTime:       time.Now(),
		PriceData:       priceData,
	}
	if configure != nil {
		configure(context, info)
	}
	summary := calculateTextQuotaSummary(context, info, &usage)
	return flatManifestTerminalCase{
		Name:          name,
		Kind:          "text",
		Model:         model,
		Snapshot:      snapshot,
		Usage:         manifestUsage,
		ExpectedQuota: summary.Quota,
	}
}

func TestGenerateCinaTokenFlatBillingTerminalManifest(t *testing.T) {
	if os.Getenv("CINATOKEN_FLAT_MANIFEST") != "1" {
		t.Skip("manifest generator only")
	}
	gin.SetMode(gin.TestMode)

	baseSnapshot := func(mode string, modelPrice *float64) flatManifestSnapshot {
		return flatManifestSnapshot{
			Mode:                 mode,
			ModelRatio:           1,
			CompletionRatio:      1,
			GroupRatio:           1,
			CacheRatio:           1,
			CacheCreationRatio:   1,
			CacheCreationRatio5m: 1,
			CacheCreationRatio1h: 1,
			ImageRatio:           1,
			AudioRatio:           1,
			AudioCompletionRatio: 1,
			QuotaPerUnit:         common.QuotaPerUnit,
			ModelPrice:           modelPrice,
			ImagePriceRatio:      1,
			OtherRatioProduct:    1,
		}
	}

	cases := make([]flatManifestTerminalCase, 0, 10)

	snapshot := baseSnapshot("per_token", nil)
	snapshot.ModelRatio = 1.25
	snapshot.CompletionRatio = 4
	snapshot.GroupRatio = 1.5
	cases = append(cases, textManifestCase(
		"per_token_basic", "manifest-basic",
		types.PriceData{ModelRatio: 1.25, CompletionRatio: 4, CacheRatio: 1, CacheCreationRatio: 1, CacheCreation5mRatio: 1, CacheCreation1hRatio: 1, ImageRatio: 1, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 1.5}},
		dto.Usage{PromptTokens: 100, CompletionTokens: 20, TotalTokens: 120}, nil,
		flatManifestUsage{PromptTokens: 100, CompletionTokens: 20, TotalTokens: 120}, snapshot,
	))

	snapshot = baseSnapshot("per_token", nil)
	snapshot.ModelRatio = 2
	snapshot.CompletionRatio = 3
	snapshot.GroupRatio = 1.25
	snapshot.CacheRatio = 0.1
	snapshot.CacheCreationRatio = 1.25
	snapshot.ImageRatio = 2
	cases = append(cases, textManifestCase(
		"openai_cache_and_image_subcategories", "manifest-media",
		types.PriceData{ModelRatio: 2, CompletionRatio: 3, CacheRatio: 0.1, CacheCreationRatio: 1.25, CacheCreation5mRatio: 1.25, CacheCreation1hRatio: 2, ImageRatio: 2, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 1.25}},
		dto.Usage{PromptTokens: 1000, CompletionTokens: 100, TotalTokens: 1100, PromptTokensDetails: dto.InputTokenDetails{CachedTokens: 200, CachedCreationTokens: 100, ImageTokens: 50}}, nil,
		flatManifestUsage{PromptTokens: 1000, CompletionTokens: 100, TotalTokens: 1100, CachedTokens: 200, CacheCreationTokens: 100, ImageTokens: 50}, snapshot,
	))

	snapshot = baseSnapshot("per_token", nil)
	snapshot.ModelRatio = 1.5
	snapshot.CompletionRatio = 5
	snapshot.GroupRatio = 0.8
	snapshot.CacheRatio = 0.1
	snapshot.CacheCreationRatio = 1.25
	snapshot.CacheCreationRatio5m = 1.25
	snapshot.CacheCreationRatio1h = 2
	cases = append(cases, textManifestCase(
		"anthropic_cache_split", "manifest-anthropic",
		types.PriceData{ModelRatio: 1.5, CompletionRatio: 5, CacheRatio: 0.1, CacheCreationRatio: 1.25, CacheCreation5mRatio: 1.25, CacheCreation1hRatio: 2, ImageRatio: 1, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 0.8}},
		dto.Usage{PromptTokens: 700, CompletionTokens: 80, TotalTokens: 780, UsageSemantic: "anthropic", PromptTokensDetails: dto.InputTokenDetails{CachedTokens: 200, CachedCreationTokens: 150}, ClaudeCacheCreation5mTokens: 100, ClaudeCacheCreation1hTokens: 50}, nil,
		flatManifestUsage{PromptTokens: 700, CompletionTokens: 80, TotalTokens: 780, CachedTokens: 200, CacheCreationTokens: 150, CacheCreation5mTokens: 100, CacheCreation1hTokens: 50, AnthropicSemantic: true}, snapshot,
	))

	snapshot = baseSnapshot("per_token", nil)
	snapshot.ModelRatio = 0.15
	snapshot.CompletionRatio = 2.5 / 0.3
	snapshot.GroupRatio = 1.2
	snapshot.AudioInputPricePerMillion = 1
	cases = append(cases, textManifestCase(
		"gemini_audio_input_price", "gemini-2.5-flash",
		types.PriceData{ModelRatio: 0.15, CompletionRatio: 2.5 / 0.3, CacheRatio: 1, CacheCreationRatio: 1, CacheCreation5mRatio: 1, CacheCreation1hRatio: 1, ImageRatio: 1, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 1.2}},
		dto.Usage{PromptTokens: 1000, CompletionTokens: 100, TotalTokens: 1100, PromptTokensDetails: dto.InputTokenDetails{AudioTokens: 200}}, nil,
		flatManifestUsage{PromptTokens: 1000, CompletionTokens: 100, TotalTokens: 1100, AudioInputTokens: 200}, snapshot,
	))

	snapshot = baseSnapshot("per_token", nil)
	snapshot.ModelRatio = 1
	snapshot.GroupRatio = 2
	cases = append(cases, textManifestCase(
		"bounded_tool_surcharges", "gpt-4o",
		types.PriceData{ModelRatio: 1, CompletionRatio: 1, CacheRatio: 1, CacheCreationRatio: 1, CacheCreation5mRatio: 1, CacheCreation1hRatio: 1, ImageRatio: 1, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 2}},
		dto.Usage{PromptTokens: 10, TotalTokens: 10},
		func(context *gin.Context, info *relaycommon.RelayInfo) {
			info.ResponsesUsageInfo = &relaycommon.ResponsesUsageInfo{BuiltInTools: map[string]*relaycommon.BuildInToolInfo{
				dto.BuildInToolWebSearchPreview: {ToolName: dto.BuildInToolWebSearchPreview, CallCount: 1},
				dto.BuildInToolFileSearch:       {ToolName: dto.BuildInToolFileSearch, CallCount: 2},
			}}
			context.Set("image_generation_call", true)
			context.Set("image_generation_call_quality", "low")
			context.Set("image_generation_call_size", "1024x1024")
		},
		flatManifestUsage{PromptTokens: 10, TotalTokens: 10, WebSearchPreviewCalls: 1, FileSearchCalls: 2, ImageGenerationPriceClass: "low_1024x1024"}, snapshot,
	))

	basePrice := 0.04
	snapshot = baseSnapshot("fixed_price", floatPointer(basePrice))
	snapshot.GroupRatio = 1.5
	snapshot.ImagePriceRatio = 2
	snapshot.OtherRatioProduct = 3
	cases = append(cases, textManifestCase(
		"fixed_image_size_quality_and_count", "dall-e-3",
		types.PriceData{UsePrice: true, ModelPrice: basePrice * 2, OtherRatios: map[string]float64{"n": 3}, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 1.5}},
		dto.Usage{PromptTokens: 1, TotalTokens: 1}, nil,
		flatManifestUsage{PromptTokens: 1, TotalTokens: 1}, snapshot,
	))

	snapshot = baseSnapshot("per_token", nil)
	snapshot.ModelRatio = 0.75
	snapshot.CompletionRatio = 2
	snapshot.GroupRatio = 123.456789
	snapshot.OtherRatioProduct = 2.5
	cases = append(cases, textManifestCase(
		"fractional_group_and_other_ratio", "manifest-fractional",
		types.PriceData{ModelRatio: 0.75, CompletionRatio: 2, CacheRatio: 1, CacheCreationRatio: 1, CacheCreation5mRatio: 1, CacheCreation1hRatio: 1, ImageRatio: 1, OtherRatios: map[string]float64{"duration": 2.5}, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 123.456789}},
		dto.Usage{PromptTokens: 999999, CompletionTokens: 333333, TotalTokens: 1333332}, nil,
		flatManifestUsage{PromptTokens: 999999, CompletionTokens: 333333, TotalTokens: 1333332}, snapshot,
	))

	zeroPrice := 0.0
	snapshot = baseSnapshot("fixed_price", &zeroPrice)
	cases = append(cases, textManifestCase(
		"free_fixed_price", "manifest-free-fixed",
		types.PriceData{UsePrice: true, ModelPrice: 0, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 1}},
		dto.Usage{PromptTokens: 1, TotalTokens: 1}, nil,
		flatManifestUsage{PromptTokens: 1, TotalTokens: 1}, snapshot,
	))

	snapshot = baseSnapshot("per_token", nil)
	snapshot.ModelRatio = 2
	snapshot.GroupRatio = 0
	cases = append(cases, textManifestCase(
		"free_zero_group", "manifest-free-group",
		types.PriceData{ModelRatio: 2, CompletionRatio: 1, CacheRatio: 1, CacheCreationRatio: 1, CacheCreation5mRatio: 1, CacheCreation1hRatio: 1, ImageRatio: 1, GroupRatioInfo: types.GroupRatioInfo{GroupRatio: 0}},
		dto.Usage{PromptTokens: 100, TotalTokens: 100}, nil,
		flatManifestUsage{PromptTokens: 100, TotalTokens: 100}, snapshot,
	))

	audioInfo := QuotaInfo{
		InputDetails:  TokenDetails{TextTokens: 100, AudioTokens: 40},
		OutputDetails: TokenDetails{TextTokens: 20, AudioTokens: 10},
		ModelName:     "manifest-audio-detail",
		ModelRatio:    1.5,
		GroupRatio:    1.25,
	}
	if err := ratio_setting.UpdateCompletionRatioByJSONString("{\"manifest-audio-detail\":3}"); err != nil {
		t.Fatal(err)
	}
	if err := ratio_setting.UpdateAudioRatioByJSONString("{\"manifest-audio-detail\":4}"); err != nil {
		t.Fatal(err)
	}
	if err := ratio_setting.UpdateAudioCompletionRatioByJSONString("{\"manifest-audio-detail\":2}"); err != nil {
		t.Fatal(err)
	}
	snapshot = baseSnapshot("per_token", nil)
	snapshot.ModelRatio = 1.5
	snapshot.CompletionRatio = 3
	snapshot.GroupRatio = 1.25
	snapshot.AudioRatio = 4
	snapshot.AudioCompletionRatio = 2
	snapshot.UsesAudioDetailBilling = true
	cases = append(cases, flatManifestTerminalCase{
		Name: "audio_detail_input_output", Kind: "audio_detail", Model: audioInfo.ModelName,
		Snapshot:      snapshot,
		Usage:         flatManifestUsage{PromptTokens: 140, CompletionTokens: 30, TotalTokens: 170, AudioInputTokens: 40, AudioOutputTokens: 10},
		ExpectedQuota: calculateAudioQuota(audioInfo),
	})

	encoded, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("CINATOKEN_FLAT_MANIFEST_JSON=%s\n", encoded)
}
