# Init

Initialization is allowed only after the user has received a Report. Show the complete local change preview and require explicit approval before any write.

The initial scaffold reserves `rally init` but does not implement writes. If it returns `not_implemented`, explain the limitation and stop.
