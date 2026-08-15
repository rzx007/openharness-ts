import type { Components } from "streamdown"

import { cn } from "@renderer/lib/utils"

type MarkdownExtraProps = {
  node?: unknown
}

type AnchorProps = React.ComponentProps<"a"> & MarkdownExtraProps
type BlockquoteProps = React.ComponentProps<"blockquote"> & MarkdownExtraProps
type CodeProps = React.ComponentProps<"code"> & MarkdownExtraProps
type HeadingProps = React.ComponentProps<"h1"> & MarkdownExtraProps
type HorizontalRuleProps = React.ComponentProps<"hr"> & MarkdownExtraProps
type ListItemProps = React.ComponentProps<"li"> & MarkdownExtraProps
type OrderedListProps = React.ComponentProps<"ol"> & MarkdownExtraProps
type ParagraphProps = React.ComponentProps<"p"> & MarkdownExtraProps
type PreProps = React.ComponentProps<"pre"> & MarkdownExtraProps
type TableCellProps = React.ComponentProps<"td"> & MarkdownExtraProps
type TableHeaderCellProps = React.ComponentProps<"th"> & MarkdownExtraProps
type TableProps = React.ComponentProps<"table"> & MarkdownExtraProps
type UnorderedListProps = React.ComponentProps<"ul"> & MarkdownExtraProps

export const quietStreamdownComponents: Components = {
  a: QuietLink,
  blockquote: QuietBlockquote,
  code: QuietCode,
  h1: QuietHeading1,
  h2: QuietHeading2,
  h3: QuietHeading3,
  h4: QuietHeading4,
  h5: QuietHeading5,
  h6: QuietHeading6,
  hr: QuietHorizontalRule,
  inlineCode: QuietInlineCode,
  li: QuietListItem,
  ol: QuietOrderedList,
  p: QuietParagraph,
  pre: QuietPre,
  table: QuietTable,
  td: QuietTableCell,
  th: QuietTableHeaderCell,
  ul: QuietUnorderedList,
}

export function QuietLink({ className, node: _node, ...props }: AnchorProps): React.JSX.Element {
  return <a data-streamdown="link" className={cn("assistant-link", className)} {...props} />
}

export function QuietInlineCode({
  className,
  node: _node,
  ...props
}: CodeProps): React.JSX.Element {
  return (
    <code
      data-streamdown="inline-code"
      className={cn("assistant-inline-code", className)}
      {...props}
    />
  )
}

function QuietParagraph({ className, node: _node, ...props }: ParagraphProps): React.JSX.Element {
  return (
    <p data-streamdown="paragraph" className={cn("assistant-paragraph", className)} {...props} />
  )
}

function QuietHeading1({ className, node: _node, ...props }: HeadingProps): React.JSX.Element {
  return (
    <h1 data-streamdown="heading-1" className={cn("assistant-heading-1", className)} {...props} />
  )
}

function QuietHeading2({ className, node: _node, ...props }: HeadingProps): React.JSX.Element {
  return (
    <h2 data-streamdown="heading-2" className={cn("assistant-heading-2", className)} {...props} />
  )
}

function QuietHeading3({ className, node: _node, ...props }: HeadingProps): React.JSX.Element {
  return (
    <h3 data-streamdown="heading-3" className={cn("assistant-heading-3", className)} {...props} />
  )
}

function QuietHeading4({ className, node: _node, ...props }: HeadingProps): React.JSX.Element {
  return (
    <h4 data-streamdown="heading-4" className={cn("assistant-heading-4", className)} {...props} />
  )
}

function QuietHeading5({ className, node: _node, ...props }: HeadingProps): React.JSX.Element {
  return (
    <h5 data-streamdown="heading-5" className={cn("assistant-heading-5", className)} {...props} />
  )
}

function QuietHeading6({ className, node: _node, ...props }: HeadingProps): React.JSX.Element {
  return (
    <h6 data-streamdown="heading-6" className={cn("assistant-heading-6", className)} {...props} />
  )
}

function QuietBlockquote({ className, node: _node, ...props }: BlockquoteProps): React.JSX.Element {
  return (
    <blockquote
      data-streamdown="blockquote"
      className={cn("assistant-blockquote", className)}
      {...props}
    />
  )
}

function QuietUnorderedList({
  className,
  node: _node,
  ...props
}: UnorderedListProps): React.JSX.Element {
  return (
    <ul data-streamdown="unordered-list" className={cn("assistant-list", className)} {...props} />
  )
}

function QuietOrderedList({
  className,
  node: _node,
  ...props
}: OrderedListProps): React.JSX.Element {
  return (
    <ol
      data-streamdown="ordered-list"
      className={cn("assistant-list assistant-list-ordered", className)}
      {...props}
    />
  )
}

function QuietListItem({ className, node: _node, ...props }: ListItemProps): React.JSX.Element {
  return (
    <li data-streamdown="list-item" className={cn("assistant-list-item", className)} {...props} />
  )
}

function QuietHorizontalRule({
  className,
  node: _node,
  ...props
}: HorizontalRuleProps): React.JSX.Element {
  return (
    <hr
      data-streamdown="horizontal-rule"
      className={cn("assistant-horizontal-rule", className)}
      {...props}
    />
  )
}

function QuietPre({ className, node: _node, ...props }: PreProps): React.JSX.Element {
  return <pre className={cn("assistant-code-pre", className)} {...props} />
}

function QuietCode({ className, node: _node, ...props }: CodeProps): React.JSX.Element {
  return <code className={cn("assistant-code", className)} {...props} />
}

function QuietTable({ className, node: _node, ...props }: TableProps): React.JSX.Element {
  return (
    <div data-streamdown="table-wrapper" className="assistant-table-wrapper">
      <table className={cn("assistant-table", className)} {...props} />
    </div>
  )
}

function QuietTableHeaderCell({
  className,
  node: _node,
  ...props
}: TableHeaderCellProps): React.JSX.Element {
  return <th className={cn("assistant-table-header-cell", className)} {...props} />
}

function QuietTableCell({ className, node: _node, ...props }: TableCellProps): React.JSX.Element {
  return <td className={cn("assistant-table-cell", className)} {...props} />
}
