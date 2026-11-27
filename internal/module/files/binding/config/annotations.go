package configbinding

import (
	"context"
	"fmt"
	"github.com/reina0721/neocloud/internal/kernel/config"
	"github.com/reina0721/neocloud/internal/module/files/model"
	"github.com/reina0721/neocloud/internal/module/files/service"
)

type AnnotationConfig struct {
	MaxBytes     int `mapstructure:"maxBytes"`
	BatchEntries int `mapstructure:"batchEntries"`
}

func annotationDefaults(ctx context.Context) (config.Object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	bytes, err := config.Number(fmt.Sprint(model.MaxAnnotationBytes))
	if err != nil {
		return nil, err
	}
	batch, err := config.Number(fmt.Sprint(service.DefaultAnnotationBatchEntries))
	if err != nil {
		return nil, err
	}
	return config.Object{config.FieldOf("maxBytes", bytes), config.FieldOf("batchEntries", batch)}, nil
}
