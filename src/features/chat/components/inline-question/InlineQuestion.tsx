import { Check } from "@/components/icons";
import type { MessageQuestion } from "@/types/electron";

import { inlineQuestionAnswerLabel } from "./answer-label";
import { useInlineQuestionAnswerHotkeys } from "./useAnswerHotkeys";

interface InlineQuestionProps {
  question: MessageQuestion;
  onSelect: (answer: string) => void;
}

export function InlineQuestion({ question, onSelect }: InlineQuestionProps) {
  const { question: questionText, answers, recommendedIndex, selectedAnswer } = question;
  const hotkeysEnabled = !selectedAnswer;

  useInlineQuestionAnswerHotkeys(answers, onSelect, hotkeysEnabled);

  if (selectedAnswer) {
    return (
      <div
        className="mt-3 rounded-xl border border-border/70 bg-muted/30 px-4 py-3"
        data-testid="inline-question-selected"
      >
        <p className="mb-2 text-sm font-medium text-foreground">{questionText}</p>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex size-5 items-center justify-center rounded-full bg-primary/15">
            <Check size={13} className="text-primary" />
          </span>
          <span>{selectedAnswer}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-3 rounded-xl border border-border/70 bg-muted/20 p-3"
      data-testid="inline-question"
    >
      <p className="mb-3 px-1 text-sm font-medium text-foreground">{questionText}</p>
      <div className="flex flex-col gap-2">
        {answers.map((answer, index) => {
          const letter = inlineQuestionAnswerLabel(index);
          const isRecommended = index === recommendedIndex;
          return (
            <button
              // eslint-disable-next-line react/no-array-index-key -- index is the stable identity; titles may be duplicated
              key={index}
              type="button"
              className="group flex w-full items-start gap-3 rounded-lg border border-border/80 bg-background/70 px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-background"
              onClick={() => onSelect(`${letter}. ${answer.title}`)}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-xs font-semibold text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-foreground">
                {letter}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium">{answer.title}</span>
                  {isRecommended && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      Recommended
                    </span>
                  )}
                </span>
                {answer.description && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {answer.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
