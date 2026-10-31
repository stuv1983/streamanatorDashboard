import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("void void-acquiring rounded-[2px]", className)}
      {...props}
    />
  )
}

export { Skeleton }
