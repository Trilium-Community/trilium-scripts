const notifications = require("libNotification.js")
const { generateCalendar } = require("libCalendar.js")
const query = require("query.js")

// Everything from the config layer is reached through libAgendaQuery, which
// re-exports it. libAgendaOverview requires only libAgendaQuery (plus the
// notification and calendar helpers) so each widget bundles config once.
const {
    loadData, saveProfile, getAllProfiles, getActiveProfile, setActiveProfile,
    getMatchingProfile, getSectionState, saveSectionState,
    getNotesForSearchGroups, getFilteredNotes, sortNoteIds,
    getPrefixes, getColors, getGroups, getGroupColumns, setGroupForNote,
    getTaskList, getSortedTaskList, NO_VALUE_KEY
} = query

// Files the sorted task list under the overview note, or under a generated folder tree, and returns every folder id.
// The backend call is awaited by callers: updateTaskLists refreshes the
// frontend note cache afterwards, which would race a fire-and-forget write.
function loadNotes(parentNoteId, notesList, folders, prefixDict, colorDict, expandLabel) {
    return api.runOnBackend((parentNoteId, notesList, folders, prefixDict, colorDict, expandLabel) => {
        const isFolder = note => note.hasLabel("agendaOverviewFolder")
        const targetOf = Object.fromEntries(notesList.map(noteId => [noteId, parentNoteId]))
        const folderIds = []
        const staleFolderIds = []

        function collectStale(folderNote) {
            staleFolderIds.push(folderNote.noteId)
            for (const child of folderNote.getChildNotes()) if (isFolder(child)) collectStale(child)
        }

        // Folders are matched by group key within their parent, so a task changing a lower level moves only inside its upper folder.
        function syncFolders(containerId, folders) {
            const existing = Object.fromEntries(api.getNote(containerId).getChildNotes()
                .filter(isFolder)
                .map(note => [note.getLabelValue("agendaOverviewFolder"), note]))
            const sortKeyWidth = String(folders.length).length
            for (const [index, folder] of folders.entries()) {
                let folderNote = existing[folder.key]
                delete existing[folder.key]
                if (!folderNote) {
                    folderNote = api.createNewNote({ parentNoteId: containerId, title: folder.title, content: "", type: "book" }).note
                    folderNote.setLabel("agendaOverviewFolder", folder.key)
                }
                if (folderNote.title !== folder.title) {
                    folderNote.title = folder.title
                    folderNote.save()
                }
                if (folder.color) {
                    if (folderNote.getLabelValue("color") !== folder.color) folderNote.setLabel("color", folder.color)
                } else if (folderNote.hasLabel("color")) {
                    folderNote.removeLabel("color")
                }
                folderNote.setLabel("agendaOverviewSort", String(index).padStart(sortKeyWidth, '0'))
                // Unflagging writes "false" rather than deleting, which is how expanded@beatlink reads an unticked box.
                const expanded = String(folder.alwaysExpanded)
                if (expandLabel && folderNote.getLabelValue(expandLabel) !== expanded
                    && (folder.alwaysExpanded || folderNote.hasLabel(expandLabel))) {
                    folderNote.setLabel(expandLabel, expanded)
                }
                folderIds.push(folderNote.noteId)
                syncFolders(folderNote.noteId, folder.children)
                if (!folder.children.length) {
                    for (const noteId of folder.noteIds) targetOf[noteId] = folderNote.noteId
                }
            }
            Object.values(existing).forEach(collectStale)
        }
        syncFolders(parentNoteId, folders)

        const sortKeyWidth = String(notesList.length).length
        for (const [index, noteId] of notesList.entries()) {
            api.toggleNoteInParent(true, noteId, targetOf[noteId], "")
            const note = api.getNote(noteId)
            note.setLabel("agendaOverviewSort", String(index).padStart(sortKeyWidth, '0'))

            if (colorDict[noteId]) {
                function setColorRecursively(note, color) {
                    note.setLabel("color", color)
                    for (const child of note.getChildNotes()) {
                        setColorRecursively(child, color)
                    }
                }
                setColorRecursively(note, colorDict[noteId])
            }
        }

        for (const managedId of [parentNoteId, ...folderIds, ...staleFolderIds]) {
            for (const note of api.getNote(managedId).getChildNotes()) {
                if (isFolder(note) || targetOf[note.noteId] === managedId) continue
                if (!(note.noteId in targetOf)) note.removeLabel("agendaOverviewSort")
                api.toggleNoteInParent(false, note.noteId, managedId, "")
            }
        }
        // Deepest first, so each stale folder is empty when it goes.
        for (const staleFolderId of staleFolderIds.reverse()) api.getNote(staleFolderId).deleteNote()

        for (const managedId of [parentNoteId, ...folderIds]) {
            api.sortNotes(managedId, { sortBy: "agendaOverviewSort" })
            for (const branch of api.getNote(managedId).getChildBranches()) {
                if (branch.noteId in prefixDict) {
                    branch.prefix = prefixDict[branch.noteId]
                    branch.save()
                }
            }
        }
        return folderIds
    }, [parentNoteId, notesList, folders, prefixDict, colorDict, expandLabel])
}

// Configures the overview note's view (list/board), promoted attributes, board
// grouping, per-note status, and board columns.
//
// Load-bearing order: flip viewType to list (unmount) -> stamp #status ->
// delete board.json -> flip viewType back. A mounted board re-persists stale
// columns otherwise. Do not reorder.
async function configureOverviewNote(overviewNoteId, viewType, boardGroupBy = "", statusByNote = {}, boardColumns = [], promotedAttributes = []) {
    if (!overviewNoteId || !viewType) return
    await api.runOnBackend((overviewNoteId, viewType, boardGroupBy, statusByNote, boardColumns, promotedAttributes) => {
        const note = api.getNote(overviewNoteId)
        if (!note) return

        if (note.type !== "book") {
            note.type = "book"
            note.save()
        }

        const promotedSignature = promotedAttributes.map(attr => `${attr.name}=${attr.definition}`).join("|")
        if (note.getLabelValue("agendaPromotedAttributes") !== promotedSignature) {
            const wantedDefinitions = new Set(promotedAttributes.map(attr => `label:${attr.name}`))
            for (const label of note.getOwnedAttributes("label")) {
                if (label.name.startsWith("label:") && !wantedDefinitions.has(label.name)) {
                    note.removeLabel(label.name)
                }
            }
            for (const attr of promotedAttributes) {
                const definitionName = `label:${attr.name}`
                if (note.getLabelValue(definitionName) !== attr.definition) {
                    note.setLabel(definitionName, attr.definition)
                }
            }
            note.setLabel("agendaPromotedAttributes", promotedSignature)
        }

        if (boardGroupBy) {
            if (note.getLabelValue("board:groupBy") !== boardGroupBy) note.setLabel("board:groupBy", boardGroupBy)
        } else if (note.hasLabel("board:groupBy")) {
            note.removeLabel("board:groupBy")
        }

        const columnsSignature = boardColumns.join(" ")
        const columnsChanged = viewType === "board" && note.getLabelValue("agendaBoardColumns") !== columnsSignature

        // Unmount the board before restamping statuses/columns (see header comment).
        if (columnsChanged && note.getLabelValue("viewType") !== "list") {
            note.setLabel("viewType", "list")
        }

        for (const [noteId, status] of Object.entries(statusByNote)) {
            const child = api.getNote(noteId)
            if (!child) continue
            if (status) {
                if (child.getLabelValue("status") !== status) child.setLabel("status", status)
            } else if (child.hasLabel("status")) {
                child.removeLabel("status")
            }
        }

        if (columnsChanged) {
            const boardAttachment = note.getAttachmentByTitle("board.json")
            if (boardAttachment) boardAttachment.markAsDeleted()
            note.setLabel("agendaBoardColumns", columnsSignature)
        }

        if (note.getLabelValue("viewType") !== viewType) {
            note.setLabel("viewType", viewType)
        }
    }, [overviewNoteId, viewType, boardGroupBy, statusByNote, boardColumns, promotedAttributes])
}

// Promoted attribute definitions shown on the overview's cards/rows.
// durationDisplay/recurrenceDisplay are declared as columns but written by
// agenda-task@beatlink, which keeps them current on every task edit. Without
// that addon installed the two columns simply stay empty.
function promotedAttributesForConstants(constants = {}) {
    const specs = [
        [constants.START_DATETIME_LABEL, "promoted,single,datetime", "Start"],
        [constants.DUE_DATETIME_LABEL, "promoted,single,datetime", "Due"],
        ["durationDisplay", "promoted,single,text", "Duration"],
        ["recurrenceDisplay", "promoted,single,text", "Recurrence"]
    ]
    return specs
        .filter(([name]) => name)
        .map(([name, definition, alias]) => ({ name, definition: `${definition},alias=${alias}` }))
}

function boardGroupByForProfile(viewType, grouping) {
    if (viewType !== "board" || !grouping) return ""
    return "status"
}

// Computes each note's board status (its group's display name) and the ordered
// list of column display names.
async function computeStatuses(dateRules, groupingInfo, noteIds) {
    const groups = await getGroups(dateRules, groupingInfo, noteIds)
    const columns = getGroupColumns(groupingInfo)
    const displayByKey = Object.fromEntries(columns.map(column => [column.key, column.display]))

    const statusByNote = {}
    for (const noteId of noteIds) {
        const key = groups[noteId]
        statusByNote[noteId] = (key != null && displayByKey[key]) ? displayByKey[key] : ""
    }
    return { statusByNote, columns: columns.map(column => column.display) }
}

// Buckets the sorted notes into one folder per non-empty group, in column order, nesting each further level inside it.
async function computeFolders(dateRules, levels, noteIds) {
    const [level, ...lowerLevels] = levels
    if (!level) return []
    const { groupingInfo, alwaysExpanded } = level
    const groups = await getGroups(dateRules, groupingInfo, noteIds)
    const columns = getGroupColumns(groupingInfo)
    if (!columns.some(column => column.key === NO_VALUE_KEY)) {
        columns.push({ key: NO_VALUE_KEY, display: "Other", color: null })
    }
    const folders = []
    for (const column of columns) {
        const folderNoteIds = noteIds.filter(noteId => (groups[noteId] ?? NO_VALUE_KEY) === column.key)
        if (!folderNoteIds.length) continue
        folders.push({
            key: column.key,
            title: column.display,
            color: column.color || "",
            alwaysExpanded,
            noteIds: folderNoteIds,
            children: await computeFolders(dateRules, lowerLevels, folderNoteIds)
        })
    }
    return folders
}

async function updateTaskLists(profileContext, constants) {
    const data = await loadData(profileContext.schemaNoteId, profileContext.configNoteId)
    const profile = await getActiveProfile(profileContext)
    if (!profile) return

    const overviewNoteId = profileContext.overviewNoteId
    if (overviewNoteId) {
        const searchedNotes = await getNotesForSearchGroups(profile.searchGroups.children)
        const filteredNotes = await getFilteredNotes(data.dateRules, profile.filterGroups.children, searchedNotes)
        const sortRule = data.sorts[profile.sorts.selected]?.rule || ""
        const sortedNotes = await sortNoteIds(sortRule, filteredNotes, data.sortValueMaps)

        const viewType = profile.viewType || "list"
        const grouping = data.groupings[profile.groupings.selected]
        const boardGroupBy = boardGroupByForProfile(viewType, grouping)

        let statusByNote = {}
        let boardColumns = []
        if (boardGroupBy === "status") {
            ({ statusByNote, columns: boardColumns } = await computeStatuses(data.dateRules, grouping, sortedNotes))
        }

        const promotedAttributes = promotedAttributesForConstants(constants)
        await configureOverviewNote(overviewNoteId, viewType, boardGroupBy, statusByNote, boardColumns, promotedAttributes)

        const prefixDict = await getPrefixes(data.dateRules, data.prefixes[profile.prefixes.selected], sortedNotes)
        const colorDict = await getColors(data.dateRules, data.colors[profile.colors.selected], sortedNotes)
        const folderLevels = (data.folderPaths[profile.folderPaths.selected]?.levels || [])
            .map(level => ({ groupingInfo: data.groupings[level.grouping], alwaysExpanded: level.alwaysExpanded }))
        const folders = await computeFolders(data.dateRules, folderLevels, sortedNotes)
        const folderNoteIds = await loadNotes(overviewNoteId, sortedNotes, folders, prefixDict, colorDict, data.expandLabel)
        for (const folderNoteId of folderNoteIds) {
            await configureOverviewNote(folderNoteId, viewType, boardGroupBy, {}, boardColumns, promotedAttributes)
        }

        // All the mutation above happens on the backend, so the frontend note
        // cache still holds the pre-change tree and the view renders stale.
        // Wait for the backend -> frontend sync, then refresh the overview note
        // and every task whose labels/branches we just rewrote.
        await api.waitUntilSynced()
        await api.reloadNotes([overviewNoteId, ...folderNoteIds, ...sortedNotes])
    }

    await setCalendarEvents(profileContext, constants)
}

async function sendNotificationForDueTasks(profileContext, constants) {
    const taskIds = await getTaskList(profileContext)
    for (const taskId of taskIds) {
        const taskNote = await api.getNote(taskId)
        const startDatetime = taskNote.getLabelValue(constants.START_DATETIME_LABEL)
        if (startDatetime && api.dayjs().isSame(startDatetime, "minute")) {
            notifications.sendNotification(taskNote.title, "", taskId)
        }
    }
}

// The feed note ships with this addon, found by the resource label Trilium routes
// /custom/agendaCalendar.ical to - unique by construction, since two notes
// claiming one path would break the route.
async function setCalendarEvents(profileContext, constants) {
    const [icalNote] = await api.searchForNotes('#customResourceProvider = "agendaCalendar.ical"')
    if (!icalNote) return

    const taskIds = await getTaskList(profileContext)
    const notes = await Promise.all(taskIds.map(taskId => api.getNote(taskId)))
    const icalString = generateCalendar(notes, {
        startDateLabel: constants.START_DATETIME_LABEL,
        dueDateLabel: constants.DUE_DATETIME_LABEL,
        recurrenceLabel: constants.RECURRENCE_LABEL
    })
    await api.runOnBackend((icalNoteId, icalString) => {
        api.getNote(icalNoteId).setContent(icalString, { forceSave: true })
    }, [icalNote.noteId, icalString])
}

// Appends a task reference to the My Day note (once), optionally as a todo item.
async function addTaskToAgendaNow(nowNoteId, taskNoteId, renderAsTodo) {
    api.runOnBackend((nowNoteId, taskNoteId, renderAsTodo) => {
        const taskNote = api.getNote(taskNoteId)
        const taskLink = `<a class="reference-link" href="#root/${taskNoteId}">${taskNote.title}</a>`

        const nowNote = api.getNote(nowNoteId)
        const nowNoteContent = nowNote.getContent()
        if (nowNoteContent.includes(taskLink)) return

        const todoListItem =
            `<ul class="todo-list"><li data-list-item-id="${api.randomString(32)}">` +
            `<label class="todo-list__label"><input type="checkbox" disabled="disabled">` +
            `<span class="todo-list__label__description">${taskLink}</span></label></li></ul>`
        const entry = renderAsTodo ? todoListItem : `<p>${taskLink}</p>`

        nowNote.setContent(nowNoteContent.concat(entry))
        nowNote.save()
    }, [nowNoteId, taskNoteId, renderAsTodo])
}

// Files every task that is due this minute onto the My Day note.
async function addDueTasksToAgendaNow(profileContext, constants, nowNoteId) {
    const taskIds = await getTaskList(profileContext)
    for (const taskId of taskIds) {
        const taskNote = await api.getNote(taskId)
        const startDatetime = taskNote.getLabelValue(constants.START_DATETIME_LABEL)
        const isDueNow = startDatetime && api.dayjs().isSame(startDatetime, "minute")
        if (isDueNow) {
            await addTaskToAgendaNow(nowNoteId, taskId, true)
        }
    }
}

module.exports = {
    loadData,
    getMatchingProfile,
    getAllProfiles,
    getActiveProfile,
    setActiveProfile,
    saveProfile,
    getTaskList,
    getSortedTaskList,
    getGroups,
    getGroupColumns,
    setGroupForNote,
    getSectionState,
    saveSectionState,
    updateTaskLists,
    sendNotificationForDueTasks,
    setCalendarEvents,
    addTaskToAgendaNow,
    addDueTasksToAgendaNow
}
