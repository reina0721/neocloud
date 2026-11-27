package service

import (
	"context"

	"github.com/reina0721/neocloud/internal/module/files/model"
)

// DirectoryRepository 只供本人目录和回收站使用，分享及检索继续使用各自的授权快照。
type DirectoryRepository interface {
	ReadDirectory(context.Context, string, DirectoryQuery) (DirectoryPage, error)
}

type DirectoryQuery struct {
	ParentID     string
	Trash        bool
	AllTrash     bool
	Sort         SortKey
	Desc         bool
	FoldersFirst bool
	Offset       int
	PageSize     int
	AnchorID     string
	BeforeAnchor bool
}

type DirectoryPage struct {
	Entries   []model.Entry
	Ancestors []model.Entry
	Anchor    model.Entry
	UsedBytes int64
	Total     int
	Offset    int
}

func (q Query) isDirectoryListing() bool {
	return (q.Scope == ScopeFolder || q.Trash && q.Scope == ScopeAll) &&
		q.Search == "" && q.Category == "" && len(q.Keywords) == 0 && len(q.Kinds) == 0 &&
		len(q.Extensions) == 0 && len(q.Tags) == 0 && q.Property == nil &&
		q.MinBytes == nil && q.MaxBytes == nil && q.CreatedFrom == nil && q.CreatedTo == nil &&
		q.ModifiedFrom == nil && q.ModifiedTo == nil
}

func (s *Service) listDirectory(ctx context.Context, owner string, q Query) (Listing, error) {
	directory := DirectoryQuery{
		ParentID: q.ParentID, Trash: q.Trash, AllTrash: q.Trash && q.Scope == ScopeAll,
		Sort: q.Sort, Desc: q.Desc, FoldersFirst: q.FoldersFirst, PageSize: q.PageSize,
		Offset: (max(1, q.Page) - 1) * q.PageSize,
	}
	var direction cursorDirection
	if q.Cursor != "" {
		var err error
		direction, directory.AnchorID, err = parseFileCursor(q.Cursor)
		if err != nil {
			return Listing{}, err
		}
		directory.BeforeAnchor = direction == cursorPrevious
	}
	page, err := s.directory.ReadDirectory(ctx, owner, directory)
	if err != nil {
		return Listing{}, err
	}
	if q.Cursor != "" {
		token, err := cursorToken(q, direction, page.Anchor)
		if err != nil {
			return Listing{}, err
		}
		if token != q.Cursor {
			return Listing{}, model.ErrConflict
		}
	}
	result := s.newListing(page.UsedBytes)
	result.Items, result.Breadcrumbs, result.Total = page.Entries, page.Ancestors, page.Total
	if q.cursorOwner != "" {
		if err := result.setCursorPage(q, page.Offset); err != nil {
			return Listing{}, err
		}
	} else if q.PageSize > 0 {
		result.Page, result.PageSize = max(1, q.Page), q.PageSize
	}
	s.setListingPageLimits(&result, q)
	return result, nil
}
