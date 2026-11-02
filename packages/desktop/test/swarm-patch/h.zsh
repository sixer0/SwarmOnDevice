emulate -L zsh; setopt err_return no_unset pipe_fail
cd -- "$1" || exit 2
/usr/bin/find . -print0 | /usr/bin/sort -z | while IFS= read -r -d $'\0' p; do
  if [[ -L $p ]]; then print -r -- "l ${p} $(/usr/bin/readlink -- "$p")"
  elif [[ -d $p ]]; then print -r -- "d ${p} $(/usr/bin/stat -f %Lp -- "$p")"
  else print -r -- "f ${p} $(/usr/bin/stat -f %Lp -- "$p") ${$(/usr/bin/shasum -a 256 < "$p")[1,64]}"; fi
done | /usr/bin/shasum -a 256
