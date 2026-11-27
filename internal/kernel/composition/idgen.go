package composition

import (
	"fmt"

	"github.com/reina0721/neocloud/internal/kernel/app"
	idgenapp "github.com/reina0721/neocloud/internal/kernel/app/idgen"
	pkgidgen "github.com/reina0721/neocloud/pkg/idgen"
)

func composeIDGenerator(plan *app.Plan) (app.Added[pkgidgen.Generator], error) {
	added, err := app.Add(plan, idgenapp.UUID())
	if err != nil {
		return app.Added[pkgidgen.Generator]{}, fmt.Errorf("compose ID generator app: %w", err)
	}
	return added, nil
}
