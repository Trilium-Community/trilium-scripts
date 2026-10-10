# Body Metrics

A log of body measurements: weight, body fat, waist, chest and any other metric you want to track,
with its own unit. Each day holds one reading per metric and a note, and the reports tab charts any
one metric over time against an optional goal. All data, the metric list and every reading, lives in
one persisted JSON note, so it's a single note you can back up, inspect, or migrate.

## Setup

1. Install the addon and enable it.
2. Open its launcher note (`body-metrics@beatlink`) to use the widget.
3. Optionally, open the addon's settings screen to pick weight and length units and enter your
   height, which turns on BMI.

## Log

The **Log** tab is one day at a time: arrows step a day, the date field jumps anywhere, **Today**
comes back. Every metric gets a row with a field for that day's reading, the most recent earlier
reading and when it was taken, the change since it, and the metric's goal.

A reading is saved when you leave the field. Clearing a field removes that reading, and a day with
no readings and no note leaves nothing behind in the database.

When a height is set, the line under the table gives BMI from the latest Weight reading on or before
the day shown.

## Metrics

The **Metrics** tab is the list of things being measured. A fresh install starts with Weight, Body
Fat, Waist, Chest, Hips, Arm, Thigh, Neck and Resting Heart Rate, and any of them can be edited,
reordered or deleted. The order here is the order they appear in everywhere else.

Each metric has a name, what it is **measured in**, an optional goal, and a note:

| Measured in | Unit shown |
|-------------|------------|
| Weight | the weight unit from settings (kg or lb) |
| Length | the length unit from settings (cm or in) |
| Percent | % |
| Custom Unit | whatever you type, such as bpm or mmHg |

Deleting a metric deletes its readings too, since there is nowhere else they could be shown. The
confirmation says how many.

## Reports

Pick a metric and a range (30 days, 90 days, 6 months, 1 year or all time) to see:

- **Cards**: the latest reading, the change across the range, the 7-day average, the lowest and
  highest readings, how many there were, and, where set, the goal and how far is left to go. The
  Weight metric also shows BMI when a height is set.
- **Chart**: each reading as a dot, the 7-day moving average as a line, and the goal as a dashed
  rule. The horizontal axis is real time, so a week without readings shows as a gap. The average at
  each point covers the readings in the 7 days ending on it, which smooths day-to-day swings such as
  water weight into the underlying trend.
- **History**: every logged day in the range, newest first, with a column per metric and the day's
  note.

Charts are drawn as inline SVG. A render note runs under a content policy that will not fetch a
charting library, so there is none to load.

## Units

Weights and lengths are plain numbers labelled with the units chosen in settings. Switching a unit
relabels what is displayed; it never converts or rewrites recorded numbers. BMI is the one place
units are converted, and it reads the units from settings to do so.

## Import and export

**Export JSON** downloads the whole database as one file. **Import JSON** merges such a file back in:
metrics not already present are added, and on a day both hold, readings already present are kept.
Importing the same file twice changes nothing, and nothing is ever wiped.

## Settings

| Setting | Description |
|---------|-------------|
| Weight Unit | Label shown beside every weight metric (kg or lb). |
| Length Unit | Label shown beside every length metric (cm or in), and the unit height is entered in. |
| Height | Your height. When above 0, BMI is shown from the Weight metric. |
| Render Note | An existing note to turn into a second view of the widget. Selecting it converts that note into a render note; clearing it reverts the previous one to a text note. |
