package archiveprocess

import (
	"errors"
	"math"
	"testing"

	"github.com/reina0721/clouddrive/internal/module/files/model"
	"github.com/reina0721/clouddrive/internal/module/files/service"
)

func TestArchiveIndexRejectsUnsignedAndAggregateOverflow(t *testing.T) {
	for _, scenario := range []struct {
		name           string
		maximum, total int64
		size           uint64
		tooLarge       bool
	}{
		{"exact budget", 10, 4, 6, false},
		{"over budget", 10, 4, 7, true},
		{"unsigned overflow", math.MaxInt64, 0, uint64(math.MaxInt64) + 1, true},
		{"negative aggregate", 10, -1, 0, true},
		{"aggregate already exceeds budget", 10, 11, 0, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			index := archiveIndex{members: map[string]service.ArchiveMember{}, explicit: map[string]bool{},
				sources: map[string]memberSource{}, maxBytes: scenario.maximum, total: scenario.total, maxMembers: 10}
			err := index.add("file.txt", 0, scenario.size, nil)
			if scenario.tooLarge && !errors.Is(err, model.ErrTooLarge) {
				t.Fatalf("expected size limit rejection, got %v", err)
			}
			if !scenario.tooLarge && (err != nil || index.total != scenario.maximum) {
				t.Fatalf("exact budget = %d, %v", index.total, err)
			}
		})
	}
}
