Run the TAU at ${tau} ${runs} times at once, from one program with the tau API, each with this
call, and keep the best run, the one with ${judge}:

${call}

Read its tau.json first. Give each run a scratch folder of its own, and in its call, give each
`out` and `inout` file a path there, copying what an `inout` file's path holds there first; pass
the rest of the call on as it is. Once every run has ended, judge them by what each left and its
final text, copy what the best one left to the paths the call gives those files, and say which run
you kept, and why.
