import { Message, MessageContent } from "@renderer/components/ui/message"
import { MessageScrollerItem } from "@renderer/components/ui/message-scroller"
import { Skeleton } from "@renderer/components/ui/skeleton"

export function ConversationTranscriptSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6" aria-busy aria-label="正在加载会话">
      <UserTurn widths={["w-52"]} />
      <AssistantTurn widths={["w-full", "w-5/6", "w-2/3"]} />
      <UserTurn widths={["w-36"]} />
      <AssistantTurn widths={["w-4/5", "w-1/2"]} />
    </div>
  )
}

function UserTurn({ widths }: { widths: string[] }): React.JSX.Element {
  return (
    <MessageScrollerItem>
      <Message align="end">
        <MessageContent className="flex w-full max-w-[78%] flex-col items-end">
          <div className="w-full max-w-64 overflow-hidden rounded-xl bg-input/80 px-4 py-3">
            {widths.map((width) => (
              <Skeleton key={width} className={`h-3.5 ${width}`} />
            ))}
          </div>
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  )
}

function AssistantTurn({ widths }: { widths: string[] }): React.JSX.Element {
  return (
    <MessageScrollerItem>
      <div className="flex min-w-0 flex-col gap-2">
        {widths.map((width) => (
          <Skeleton key={width} className={`h-3.5 ${width}`} />
        ))}
      </div>
    </MessageScrollerItem>
  )
}
