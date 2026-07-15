package helper

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/cinagroup/cinatoken/dto"
	relaycommon "github.com/cinagroup/cinatoken/relay/common"
	"github.com/cinagroup/cinatoken/setting/operation_setting"
	"github.com/cinagroup/cinatoken/setting/ratio_setting"
	"github.com/cinagroup/cinatoken/types"
	"github.com/gin-gonic/gin"
)

type flatAdmissionInput struct {
	Model                     string  `json:"model"`
	Group                     string  `json:"group"`
	PromptTokens              int     `json:"prompt_tokens"`
	MaxTokens                 int     `json:"max_tokens"`
	ImagePriceRatio           float64 `json:"image_price_ratio"`
	ModelRatios               string  `json:"model_ratios"`
	CompletionRatios          string  `json:"completion_ratios"`
	ModelPrices               string  `json:"model_prices"`
	CacheRatios               string  `json:"cache_ratios"`
	CreateCacheRatios         string  `json:"create_cache_ratios"`
	ImageRatios               string  `json:"image_ratios"`
	AudioRatios               string  `json:"audio_ratios"`
	AudioCompletionRatios     string  `json:"audio_completion_ratios"`
	GroupRatios               string  `json:"group_ratios"`
	SelfUseMode               bool    `json:"self_use_mode"`
	AcceptUnsetRatioModel     bool    `json:"accept_unset_ratio_model"`
	EnableFreeModelPreConsume bool    `json:"enable_free_model_pre_consume"`
}

type flatAdmissionOutput struct {
	Admitted             bool    `json:"admitted"`
	Mode                 string  `json:"mode,omitempty"`
	ModelPrice           float64 `json:"model_price"`
	ModelRatio           float64 `json:"model_ratio"`
	CompletionRatio      float64 `json:"completion_ratio"`
	GroupRatio           float64 `json:"group_ratio"`
	CacheRatio           float64 `json:"cache_ratio"`
	CacheCreationRatio   float64 `json:"cache_creation_ratio"`
	ImageRatio           float64 `json:"image_ratio"`
	AudioRatio           float64 `json:"audio_ratio"`
	AudioCompletionRatio float64 `json:"audio_completion_ratio"`
	PreConsumedQuota     int     `json:"pre_consumed_quota"`
	FreeModel            bool    `json:"free_model"`
	ErrorCode            string  `json:"error_code,omitempty"`
}

type flatAdmissionCase struct {
	Name     string              `json:"name"`
	Input    flatAdmissionInput  `json:"input"`
	Expected flatAdmissionOutput `json:"expected"`
}

func applyFlatAdmissionInput(t *testing.T, input flatAdmissionInput) {
	t.Helper()
	for name, update := range map[string]func(string) error{
		"model ratios":            ratio_setting.UpdateModelRatioByJSONString,
		"completion ratios":       ratio_setting.UpdateCompletionRatioByJSONString,
		"model prices":            ratio_setting.UpdateModelPriceByJSONString,
		"cache ratios":            ratio_setting.UpdateCacheRatioByJSONString,
		"create-cache ratios":     ratio_setting.UpdateCreateCacheRatioByJSONString,
		"image ratios":            ratio_setting.UpdateImageRatioByJSONString,
		"audio ratios":            ratio_setting.UpdateAudioRatioByJSONString,
		"audio completion ratios": ratio_setting.UpdateAudioCompletionRatioByJSONString,
		"group ratios":            ratio_setting.UpdateGroupRatioByJSONString,
	} {
		value := map[string]string{
			"model ratios": input.ModelRatios, "completion ratios": input.CompletionRatios,
			"model prices": input.ModelPrices, "cache ratios": input.CacheRatios,
			"create-cache ratios": input.CreateCacheRatios, "image ratios": input.ImageRatios,
			"audio ratios": input.AudioRatios, "audio completion ratios": input.AudioCompletionRatios,
			"group ratios": input.GroupRatios,
		}[name]
		if err := update(value); err != nil {
			t.Fatalf("update %s: %v", name, err)
		}
	}
	operation_setting.SelfUseModeEnabled = input.SelfUseMode
	operation_setting.GetQuotaSetting().EnableFreeModelPreConsume = input.EnableFreeModelPreConsume
}

func TestGenerateCinaTokenFlatBillingAdmissionManifest(t *testing.T) {
	if os.Getenv("CINATOKEN_FLAT_MANIFEST") != "1" {
		t.Skip("manifest generator only")
	}
	gin.SetMode(gin.TestMode)

	base := func(model string) flatAdmissionInput {
		return flatAdmissionInput{
			Model: model, Group: "default", PromptTokens: 100, MaxTokens: 20,
			ModelRatios: "{}", CompletionRatios: "{}", ModelPrices: "{}",
			CacheRatios: "{}", CreateCacheRatios: "{}", ImageRatios: "{}",
			AudioRatios: "{}", AudioCompletionRatios: "{}",
			GroupRatios: "{\"default\":1}", EnableFreeModelPreConsume: true,
		}
	}

	configuredRatio := base("manifest-ratio")
	configuredRatio.ModelRatios = "{\"manifest-ratio\":1.25}"
	configuredRatio.CompletionRatios = "{\"manifest-ratio\":3}"
	configuredRatio.CacheRatios = "{\"manifest-ratio\":0.1}"
	configuredRatio.CreateCacheRatios = "{\"manifest-ratio\":1.4}"
	configuredRatio.ImageRatios = "{\"manifest-ratio\":2}"
	configuredRatio.AudioRatios = "{\"manifest-ratio\":4}"
	configuredRatio.AudioCompletionRatios = "{\"manifest-ratio\":2}"
	configuredRatio.GroupRatios = "{\"default\":1.5}"

	configuredPrice := base("manifest-fixed")
	configuredPrice.ModelPrices = "{\"manifest-fixed\":0.04}"
	configuredPrice.GroupRatios = "{\"default\":1.5}"
	configuredPrice.ImagePriceRatio = 2

	unknownDenied := base("manifest-unknown-denied")
	unknownAccepted := base("manifest-unknown-accepted")
	unknownAccepted.AcceptUnsetRatioModel = true

	freePrice := base("manifest-free-price")
	freePrice.ModelPrices = "{\"manifest-free-price\":0}"
	freePrice.EnableFreeModelPreConsume = false

	freeRatio := base("manifest-free-ratio")
	freeRatio.ModelRatios = "{\"manifest-free-ratio\":0}"
	freeRatio.EnableFreeModelPreConsume = false

	freeGroup := base("manifest-free-group")
	freeGroup.ModelRatios = "{\"manifest-free-group\":2}"
	freeGroup.GroupRatios = "{\"default\":0}"
	freeGroup.EnableFreeModelPreConsume = false

	freePreconsumeEnabled := freePrice
	freePreconsumeEnabled.Model = "manifest-free-price-enabled"
	freePreconsumeEnabled.ModelPrices = "{\"manifest-free-price-enabled\":0}"
	freePreconsumeEnabled.EnableFreeModelPreConsume = true

	inputs := []struct {
		name  string
		input flatAdmissionInput
	}{
		{"configured_per_token", configuredRatio},
		{"configured_fixed_price", configuredPrice},
		{"unknown_model_denied", unknownDenied},
		{"unknown_model_user_accepted", unknownAccepted},
		{"free_zero_model_price", freePrice},
		{"free_zero_model_ratio", freeRatio},
		{"free_zero_group_ratio", freeGroup},
		{"zero_price_preconsume_enabled", freePreconsumeEnabled},
	}

	cases := make([]flatAdmissionCase, 0, len(inputs))
	for _, fixture := range inputs {
		applyFlatAdmissionInput(t, fixture.input)
		context, _ := gin.CreateTestContext(httptest.NewRecorder())
		info := &relaycommon.RelayInfo{
			OriginModelName: fixture.input.Model,
			UsingGroup:      fixture.input.Group,
			UserGroup:       fixture.input.Group,
			UserSetting:     dto.UserSetting{AcceptUnsetRatioModel: fixture.input.AcceptUnsetRatioModel},
		}
		price, err := ModelPriceHelper(context, info, fixture.input.PromptTokens, &types.TokenCountMeta{
			MaxTokens: fixture.input.MaxTokens, ImagePriceRatio: fixture.input.ImagePriceRatio,
		})
		output := flatAdmissionOutput{}
		if err != nil {
			output.ErrorCode = "model_price_not_configured"
		} else {
			output = flatAdmissionOutput{
				Admitted: true, Mode: map[bool]string{true: "fixed_price", false: "per_token"}[price.UsePrice],
				ModelPrice: price.ModelPrice, ModelRatio: price.ModelRatio,
				CompletionRatio: price.CompletionRatio, GroupRatio: price.GroupRatioInfo.GroupRatio,
				CacheRatio: price.CacheRatio, CacheCreationRatio: price.CacheCreationRatio,
				ImageRatio: price.ImageRatio, AudioRatio: price.AudioRatio,
				AudioCompletionRatio: price.AudioCompletionRatio,
				PreConsumedQuota:     price.QuotaToPreConsume, FreeModel: price.FreeModel,
			}
		}
		cases = append(cases, flatAdmissionCase{Name: fixture.name, Input: fixture.input, Expected: output})
	}

	encoded, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("CINATOKEN_FLAT_MANIFEST_JSON=%s\n", encoded)
}
